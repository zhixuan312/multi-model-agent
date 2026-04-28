import { describe, it, expect } from 'vitest';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';

async function pollToTerminal(h: HarnessHandle, batchId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const poll = await fetch(`${h.baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    if (poll.status === 200) {
      return await poll.json() as Record<string, unknown>;
    }
    expect(poll.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

describe('contract: POST /retry', () => {
  it('retry incomplete task returns 202 then terminal envelope matching golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'incomplete' }), cwd: process.cwd() });
    try {
      // Dispatch and poll to terminal
      const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ tasks: [{ prompt: 'hello' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId: dispatchBatchId } = (await dispatch.json()) as { batchId: string };

      const dispatchTerminal = await pollToTerminal(h, dispatchBatchId);
      // The batchCache-level batchId lives in the terminal payload; this is
      // the ID retry_tasks operates on, not the dispatch/registry batchId.
      const cacheBatchId = dispatchTerminal['batchId'] as string;

      // Now retry the first task
      const retryRes = await fetch(`${h.baseUrl}/retry?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ batchId: cacheBatchId, taskIndices: [0] }),
      });
      expect(retryRes.status).toBe(202);
      const { batchId: newBatchId } = (await retryRes.json()) as { batchId: string };

      // Poll the retry batch to terminal
      const terminal = await pollToTerminal(h, newBatchId);

      const normalized = normalize(terminal);
      const goldenRel = '../goldens/endpoints/retry-tasks-ok.json';
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
  });
});