import { describe, it, expect } from 'vitest';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';

async function pollToTerminal(h: HarnessHandle, batchId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const poll = await fetch(`${h.baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    if (poll.status === 200) return;
    expect(poll.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

describe('contract: GET /batch/:id?taskIndex=N', () => {
  it('taskIndex=0 on 2-task batch returns 200 with sliced golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ tasks: [{ prompt: 'task one' }, { prompt: 'task two' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      await pollToTerminal(h, batchId);

      const res = await fetch(`${h.baseUrl}/batch/${batchId}?taskIndex=0`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const normalized = normalize(await res.json());
      const goldenRel = '../goldens/endpoints/get-batch-slice-ok.json';
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

  it('taskIndex=5 on 2-task batch returns 404 out-of-range golden', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ tasks: [{ prompt: 'task one' }, { prompt: 'task two' }] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };

      await pollToTerminal(h, batchId);

      const res = await fetch(`${h.baseUrl}/batch/${batchId}?taskIndex=5`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(404);
      const normalized2 = normalize(await res.json());
      const goldenRel2 = '../goldens/endpoints/get-batch-slice-out-of-range.json';
      if (process.env.CAPTURE_GOLDEN === '1') {
        const { writeFileSync } = await import('node:fs');
        const { resolve, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const here = dirname(fileURLToPath(import.meta.url));
        writeFileSync(resolve(here, goldenRel2), JSON.stringify(normalized2, null, 2) + '\n', 'utf8');
      } else {
        const expected2 = (await import(goldenRel2, { with: { type: 'json' } })).default;
        expect(normalized2).toEqual(expected2);
      }
    } finally {
      await h.close();
    }
  });
});