import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider, type Stage } from '../fixtures/mock-providers.js';
import { normalize, type JsonValue } from '../serializer/index.js';

// NOTE: per post-refactor-queue (Phase 6 ExecutionContext trap) the
// mockProvider override is not yet wired through run-tasks, so all stages
// currently produce identical envelopes (connection-error path). These
// goldens pin the *envelope shape* for the HTTP surface and will ratify
// divergence when Chapter 4 wires the runner adapter layer.

const STAGES: Stage[] = ['ok', 'incomplete', 'force-salvage', 'max-turns', 'clarification', 'review-rework'];

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<JsonValue> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return (await poll.json()) as JsonValue;
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

describe('contract: POST /delegate', () => {
  async function dispatch(body: unknown) {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const res = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify(body),
    });
    await h.close();
    return res;
  }

  it('accepts agentType: standard', async () => {
    const res = await dispatch({ tasks: [{ prompt: 'test', agentType: 'standard' }] });
    expect(res.status).toBe(202);
  });

  it('accepts agentType: complex', async () => {
    const res = await dispatch({ tasks: [{ prompt: 'test', agentType: 'complex' }] });
    expect(res.status).toBe(202);
  });

  for (const stage of STAGES) {
    it(`produces the ${stage} envelope`, async () => {
      const h = await boot({ provider: mockProvider({ stage }), cwd: process.cwd() });
      try {
        const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
          body: JSON.stringify({ tasks: [{ prompt: 'golden delegate test prompt — please just echo ok' }] }),
        });
        expect(dispatch.status).toBe(202);
        const { batchId } = (await dispatch.json()) as { batchId: string };
        const terminal = await pollToTerminal(h.baseUrl, h.token, batchId);
        const normalized = normalize(terminal);
        const goldenRel = `../goldens/endpoints/delegate-${stage}.json`;
        if (process.env.CAPTURE_GOLDEN === '1') {
          const { writeFileSync } = await import('node:fs');
          const { resolve, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          const here = dirname(fileURLToPath(import.meta.url));
          writeFileSync(resolve(here, goldenRel), JSON.stringify(normalized, null, 2) + '\n', 'utf8');
        } else {
          const expected = (await import(goldenRel, { with: { type: 'json' } })).default;
          expect(normalized).toEqual(expected);
        }
      } finally {
        await h.close();
      }
    }, 60_000);
  }
});
