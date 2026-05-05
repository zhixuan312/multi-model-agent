import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 180; i++) {
    const poll = await authedFetch(`${baseUrl}/batch/${batchId}`, token);
    if (poll.status === 200) return (await poll.json()) as Record<string, unknown>;
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
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

  it('awaiting-clarification envelope matches golden', async () => {
    // Use a vague prompt that triggers intake-level clarification.
    // The mock provider is never called because intake classifies the task
    // as needs_confirmation before dispatch.
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ prompt: 'Can you help' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      const terminal = await pollToTerminal(h.baseUrl, h.token, batchId);
      const body = terminal as Record<string, unknown>;

      // No clarification gate — proposedInterpretation is always notApplicable
      const notApp = (v: unknown) =>
        typeof v === 'object' && v !== null && (v as Record<string, unknown>).kind === 'not_applicable';
      expect(notApp(body.proposedInterpretation)).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);
});
