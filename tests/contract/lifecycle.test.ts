import { describe, it, expect } from 'vitest';
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe('contract: polling lifecycle', () => {
  it('returns 202 with running headline then 200 with terminal envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'hello' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };
      expect(batchId).toMatch(/^[a-f0-9-]+$/i);

      let terminal: Response | null = null;
      for (let i = 0; i < 30; i++) {
        const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token);
        if (poll.status === 200) {
          terminal = poll;
          break;
        }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(terminal).not.toBeNull();
      const body = await terminal!.json() as Record<string, unknown>;
      for (const k of ['results', 'headline', 'batchTimings', 'costSummary', 'structuredReport', 'error', 'proposedInterpretation']) {
        expect(body).toHaveProperty(k);
      }
    } finally {
      await h.close();
    }
  });

  it('repeated poll after terminal returns identical body (idempotent)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'x' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      let first: unknown;
      for (let i = 0; i < 30; i++) {
        const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token);
        if (poll.status === 200) {
          first = await poll.json();
          break;
        }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(first).toBeDefined();
      const second = await (await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token)).json();
      expect(second).toEqual(first);
    } finally {
      await h.close();
    }
  });

  // TODO(post-refactor-queue): restore clarification-precedence assertion.
  // Current premise is wrong: `mockProvider({stage: 'clarification'})` drives
  // the provider layer, but intake clarification is triggered by prompt
  // heuristics in the intake pipeline (classify/infer), not by provider
  // output. A correct test needs a prompt the intake actually classifies as
  // ambiguous. Logged to docs/superpowers/refactor/post-refactor-queue.md.
  it.skip('clarification reaches awaiting_clarification with error subordinate', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'clarification' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'ambiguous' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      let terminalBody: { proposedInterpretation: { kind?: string } | string; error: { kind?: string } | unknown } | null = null;
      for (let i = 0; i < 30; i++) {
        const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, h.token);
        if (poll.status === 200) {
          terminalBody = await poll.json();
          break;
        }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(terminalBody, 'clarification batch must reach a terminal 200 response').not.toBeNull();

      const pi = terminalBody!.proposedInterpretation as { kind?: string } | string;
      const piKind = typeof pi === 'string' ? 'string' : pi.kind;
      expect(piKind, 'proposedInterpretation must not be not_applicable').not.toBe('not_applicable');

      const err = terminalBody!.error as { kind?: string };
      expect(err?.kind, 'error must be not_applicable when clarification wins').toBe('not_applicable');
    } finally {
      await h.close();
    }
  });
});
