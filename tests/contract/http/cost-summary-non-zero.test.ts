import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

/**
 * A11.2 — public envelope per-task cost surface.
 *
 * Verifies:
 *  1. `result.actualCostUSD` is the sum of `result.stageStats[*].costUSD`
 *     across entered stages (the canonical per-task figure).
 *  2. `costSummary.totalActualCostUSD` (batch roll-up from A11.1) equals
 *     the sum of every task's `actualCostUSD` — no drift between the
 *     two pathways.
 *
 * Uses a mock provider that returns a deterministic small cost. The
 * audit route dispatches one task; we assert the cost numbers line up.
 */

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<unknown> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { 'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return await poll.json();
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

describe('A11.2 public-envelope cost roll-up', () => {
  it('per-task actualCostUSD matches sumStageCosts and batch roll-up matches per-task sum', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/review?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ filePaths: ['/tmp/add.ts'] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };
      const envelope = (await pollToTerminal(h.baseUrl, h.token, batchId)) as {
        results: Array<{ stageStats?: Record<string, { entered?: boolean; costUSD?: number | null }>; actualCostUSD?: number | null }>;
        costSummary: { totalActualCostUSD: number };
      };

      // Compute expected per-task sum from stageStats[*].costUSD across entered stages.
      const stageStats = envelope.results[0].stageStats ?? {};
      let expectedPerTask: number | null = null;
      let anyFinite = false;
      for (const stage of Object.values(stageStats)) {
        if (!stage?.entered) continue;
        const c = stage.costUSD;
        if (typeof c === 'number' && Number.isFinite(c)) {
          expectedPerTask = (expectedPerTask ?? 0) + c;
          anyFinite = true;
        }
      }
      // Honest-zero contract: when no entered stage has finite cost, value is null.
      const expectedFinal = anyFinite ? expectedPerTask : null;

      // 1. Per-task actualCostUSD matches the helper's output.
      if (expectedFinal === null) {
        expect(envelope.results[0].actualCostUSD ?? null).toBeNull();
      } else {
        expect(envelope.results[0].actualCostUSD).toBeCloseTo(expectedFinal, 6);
      }

      // 2. Batch roll-up matches sum of per-task actualCostUSD.
      const taskSum = envelope.results.reduce((acc, r) => acc + (r.actualCostUSD ?? 0), 0);
      expect(envelope.costSummary.totalActualCostUSD).toBeCloseTo(taskSum, 6);
    } finally {
      await h.close();
    }
  }, 60_000);
});
