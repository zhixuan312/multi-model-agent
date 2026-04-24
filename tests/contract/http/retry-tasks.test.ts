import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import okGolden from '../goldens/endpoints/retry-tasks-ok.json' with { type: 'json' };

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

async function pollToTerminal(h: HarnessHandle, batchId: string, token: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, token);
    if (poll.status === 200) {
      return await poll.json() as Record<string, unknown>;
    }
    expect(poll.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

describe('contract: POST /retry', () => {
  it.todo('retry incomplete task returns 202 then terminal envelope matching golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'incomplete' }), cwd: process.cwd() });
    try {
      // Dispatch and poll to terminal
      const dispatch = await authedFetch(
        `${h.baseUrl}/delegate?cwd=${process.cwd()}`,
        h.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: [{ prompt: 'hello' }] }),
        },
      );
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      await pollToTerminal(h, batchId, h.token);

      // Now retry the first task
      const retryRes = await authedFetch(`${h.baseUrl}/retry`, h.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, taskIndices: [0] }),
      });
      expect(retryRes.status).toBe(202);
      const { batchId: newBatchId } = (await retryRes.json()) as { batchId: string };

      // Poll the retry batch to terminal
      const terminal = await pollToTerminal(h, newBatchId, h.token);

      expect(normalize(terminal)).toEqual(okGolden);
    } finally {
      await h.close();
    }
  });
});
