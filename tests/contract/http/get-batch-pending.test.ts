import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

async function waitForPendingHeadline(
  baseUrl: string,
  token: string,
  batchId: string,
  timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    if (r.status === 202 && /— \d+s/.test(body)) return { status: r.status, body };
    if (r.status !== 202) throw new Error(`expected 202 pending; got ${r.status}: ${body}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('timed out waiting for pending headline with elapsed');
}

describe('GET /batch/:id 202 polling response', () => {
  it('shows live elapsed time that increases between polls', async () => {
    const h = await boot({
      provider: mockProvider({ stage: 'slow', delayMs: 8000 }),
      cwd: process.cwd(),
    });
    try {
      const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'noop slow', filePaths: ['x.txt'] }] }),
      });
      const { batchId } = (await dispatch.json()) as { batchId: string };
      const first = await waitForPendingHeadline(h.baseUrl, h.token, batchId);
      const e1 = parseInt(first.body.match(/— (\d+)s/)![1]!);
      await new Promise((r) => setTimeout(r, 1100));
      const second = await waitForPendingHeadline(h.baseUrl, h.token, batchId);
      const e2 = parseInt(second.body.match(/— (\d+)s/)![1]!);
      expect(e2).toBeGreaterThan(e1);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('omits stats clause when no counters have fired', async () => {
    const h = await boot({
      provider: mockProvider({ stage: 'slow', delayMs: 8000, suppressProgress: true }),
      cwd: process.cwd(),
    });
    try {
      const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'noop test', filePaths: ['x.txt'] }] }),
      });
      const { batchId } = (await dispatch.json()) as { batchId: string };
      const { body } = await waitForPendingHeadline(h.baseUrl, h.token, batchId);
      // Body should end with `— Xs` (no trailing stats clause)
      expect(body).toMatch(/— \d+s$/);
    } finally {
      await h.close();
    }
  }, 30_000);
});
