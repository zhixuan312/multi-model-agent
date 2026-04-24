import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import okGolden from '../goldens/endpoints/get-batch-slice-ok.json' with { type: 'json' };
import outOfRangeGolden from '../goldens/endpoints/get-batch-slice-out-of-range.json' with { type: 'json' };

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

async function pollToTerminal(h: HarnessHandle, batchId: string, token: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const poll = await authedFetch(`${h.baseUrl}/batch/${batchId}`, token);
    if (poll.status === 200) return;
    expect(poll.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

describe('contract: GET /batch/:id?taskIndex=N', () => {
  it.todo('taskIndex=0 on 2-task batch returns 200 with sliced golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(
        `${h.baseUrl}/delegate?cwd=${process.cwd()}`,
        h.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: [{ prompt: 'task one' }, { prompt: 'task two' }] }),
        },
      );
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      await pollToTerminal(h, batchId, h.token);

      const res = await authedFetch(`${h.baseUrl}/batch/${batchId}?taskIndex=0`, h.token);
      expect(res.status).toBe(200);
      expect(normalize(await res.json())).toEqual(okGolden);
    } finally {
      await h.close();
    }
  });

  it.todo('taskIndex=5 on 2-task batch returns 404 out-of-range golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await authedFetch(
        `${h.baseUrl}/delegate?cwd=${process.cwd()}`,
        h.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: [{ prompt: 'task one' }, { prompt: 'task two' }] }),
        },
      );
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      await pollToTerminal(h, batchId, h.token);

      const res = await authedFetch(`${h.baseUrl}/batch/${batchId}?taskIndex=5`, h.token);
      expect(res.status).toBe(404);
      expect(normalize(await res.json())).toEqual(outOfRangeGolden);
    } finally {
      await h.close();
    }
  });
});
