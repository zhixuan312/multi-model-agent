// Regression tests for two public-contract defects found by live manual testing against a
// running daemon (2026-08-14):
//
// DEFECT 1 — `initiative_resume` and `initiative_gate_status` had INCOMPATIBLE HTTP envelopes.
// `initiative_gate_status` already used the canonical `{ operation, input: { initiative } }`
// envelope every other operation uses (SPEC-004 FR-9); `initiative_resume` predated that
// convention and instead required a top-level `initiative` field, rejecting `input` outright.
// This asserts `initiative_resume` now accepts the SAME canonical envelope as every other
// operation, and that the old top-level shape is rejected rather than silently still accepted.
//
// DEFECT 2 — the four lifecycle phase mutations (`initiative_phase_enter`, `_satisfy`,
// `_reopen`, `_skip`) returned only `{ initiative_id, phase, state }` — no `revision` — even
// though every mutation requires `expected_revision`, forcing a caller to issue an extra
// `initiative_get`/`initiative_resume` between every phase transition just to learn the next
// `expected_revision`. Their sibling `initiative_focus_set` (added by the same specification)
// already returns the full Initiative including `revision`. This asserts each of the four
// mutations returns a `revision` the VERY NEXT mutation accepts as `expected_revision`, with
// zero intervening reads.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'manual' };

async function post(h: { baseUrl: string; token: string }, body: Record<string, unknown>) {
  return fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify(body) });
}

describe('Live-manual-test public-contract regressions (2026-08-14)', () => {
  it('DEFECT 1: initiative_resume accepts the canonical { operation, input } envelope and rejects the old top-level shape', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await post(h, { operation: 'product_create', input: { name: 'MMA', slug: 'resume-envelope' }, expected_revision: 0, provenance });
      const productBody = (await product.json()) as { uuid: string };
      const initiative = await post(h, {
        operation: 'initiative_create',
        input: { product_id: productBody.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const initiativeBody = (await initiative.json()) as { uuid: string };

      // Canonical envelope — the SAME shape `initiative_gate_status` already requires — must work.
      const canonical = await post(h, { operation: 'initiative_resume', input: { initiative: { uuid: initiativeBody.uuid } } });
      expect(canonical.status).toBe(200);
      const resumed = (await canonical.json()) as { initiative: { uuid: string } };
      expect(resumed.initiative.uuid).toBe(initiativeBody.uuid);

      // The OLD top-level shape (`{ operation, initiative }`, no `input`) must be REJECTED, not
      // silently still accepted — no dual-shape acceptance.
      const oldShape = await post(h, { operation: 'initiative_resume', initiative: { uuid: initiativeBody.uuid } });
      expect(oldShape.status).toBe(400);
      expect(((await oldShape.json()) as { error: { code: string } }).error.code).toBe('invalid_request');

      // A valid `input` does not make a legacy top-level `initiative` field acceptable: the
      // complete outer envelope is strict, so callers cannot mix the two contracts.
      const mixedShape = await post(h, {
        operation: 'initiative_resume',
        input: { initiative: { uuid: initiativeBody.uuid } },
        initiative: { uuid: initiativeBody.uuid },
      });
      expect(mixedShape.status).toBe(400);
      expect(((await mixedShape.json()) as { error: { code: string } }).error.code).toBe('invalid_request');

      // MCP omits the redundant `operation` because its tool name selects it, but otherwise
      // must expose the same `{ input: ... }` envelope as every other Initiative tool.
      const client = new Client({ name: 'resume-envelope-regression', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${h.token}` } },
      }));
      try {
        const mcpCanonical = await client.callTool({
          name: 'mma_initiative_resume',
          arguments: { input: { initiative: { uuid: initiativeBody.uuid } } },
        });
        expect(mcpCanonical.isError).not.toBe(true);
        expect(JSON.parse((mcpCanonical.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
          initiative: { uuid: initiativeBody.uuid },
        });

        const mcpOldShape = await client.callTool({
          name: 'mma_initiative_resume',
          arguments: { initiative: { uuid: initiativeBody.uuid } },
        });
        expect(mcpOldShape.isError).toBe(true);
        expect(JSON.parse((mcpOldShape.content as Array<{ text: string }>)[0]!.text).error.code).toBe('invalid_request');

        const mcpMixedShape = await client.callTool({
          name: 'mma_initiative_resume',
          arguments: {
            input: { initiative: { uuid: initiativeBody.uuid } },
            initiative: { uuid: initiativeBody.uuid },
          },
        });
        expect(mcpMixedShape.isError).toBe(true);
        expect(JSON.parse((mcpMixedShape.content as Array<{ text: string }>)[0]!.text).error.code).toBe('invalid_request');
      } finally {
        await client.close();
      }
    } finally {
      await h.close();
    }
  });

  it('DEFECT 2: every phase mutation returns a revision the next mutation accepts, with zero intervening reads', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await post(h, { operation: 'product_create', input: { name: 'MMA', slug: 'phase-revision-chain' }, expected_revision: 0, provenance });
      const productBody = (await product.json()) as { uuid: string };
      const initiative = await post(h, {
        operation: 'initiative_create',
        input: { product_id: productBody.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const initiativeBody = (await initiative.json()) as { uuid: string; revision: number };

      // initiative_phase_enter (not_started -> active): chained off the CREATE response's own
      // revision — the first link with no read at all.
      const entered = await post(h, {
        operation: 'initiative_phase_enter',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'discover' },
        expected_revision: initiativeBody.revision,
        provenance,
      });
      expect(entered.status).toBe(200);
      const enteredBody = (await entered.json()) as { revision: number };
      expect(typeof enteredBody.revision).toBe('number');

      // initiative_phase_satisfy (active -> satisfied): chained off phase_enter's OWN response.
      const satisfied = await post(h, {
        operation: 'initiative_phase_satisfy',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'discover' },
        expected_revision: enteredBody.revision,
        provenance,
      });
      expect(satisfied.status).toBe(200);
      const satisfiedBody = (await satisfied.json()) as { revision: number };
      expect(typeof satisfiedBody.revision).toBe('number');

      // initiative_phase_reopen (satisfied -> reopened): chained off phase_satisfy's OWN response.
      const reopened = await post(h, {
        operation: 'initiative_phase_reopen',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'discover', reason: 'new finding' },
        expected_revision: satisfiedBody.revision,
        provenance,
      });
      expect(reopened.status).toBe(200);
      const reopenedBody = (await reopened.json()) as { revision: number };
      expect(typeof reopenedBody.revision).toBe('number');

      // A second phase's initiative_phase_enter (not_started -> active): chained off
      // phase_reopen's OWN response.
      const enteredDesign = await post(h, {
        operation: 'initiative_phase_enter',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'design' },
        expected_revision: reopenedBody.revision,
        provenance,
      });
      expect(enteredDesign.status).toBe(200);
      const enteredDesignBody = (await enteredDesign.json()) as { revision: number };
      expect(typeof enteredDesignBody.revision).toBe('number');

      // initiative_phase_skip (active -> skipped): chained off the second phase_enter's OWN
      // response — proves all four mutations return a usable revision, never an intervening read.
      const skipped = await post(h, {
        operation: 'initiative_phase_skip',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'design', reason: 'not needed' },
        expected_revision: enteredDesignBody.revision,
        provenance,
      });
      expect(skipped.status).toBe(200);
      const skippedBody = (await skipped.json()) as { revision: number };
      expect(typeof skippedBody.revision).toBe('number');

      // `initiative_phase_reopen` (skipped -> reopened): this final mutation proves the
      // `initiative_phase_skip` response is itself usable as the next expected_revision.
      const reopenedAfterSkip = await post(h, {
        operation: 'initiative_phase_reopen',
        input: { initiative: { uuid: initiativeBody.uuid }, phase: 'design', reason: 'needed after all' },
        expected_revision: skippedBody.revision,
        provenance,
      });
      expect(reopenedAfterSkip.status).toBe(200);
      const reopenedAfterSkipBody = (await reopenedAfterSkip.json()) as { revision: number };
      expect(typeof reopenedAfterSkipBody.revision).toBe('number');

      // Final proof: an independent initiative_get confirms the chain's last revision matches
      // ground truth — the whole chain above never needed that read to keep going.
      const finalGet = await post(h, { operation: 'initiative_get', input: { uuid: initiativeBody.uuid } });
      const finalGetBody = (await finalGet.json()) as { revision: number };
      expect(reopenedAfterSkipBody.revision).toBe(finalGetBody.revision);
    } finally {
      await h.close();
    }
  });
});
