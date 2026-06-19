import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

async function pollToTerminal(baseUrl: string, token: string, taskId: string): Promise<unknown> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/task/${taskId}`, {
      headers: { 'X-MMA-Main-Model': 'claude-opus-4-8', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return await poll.json();
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${taskId}`);
}

describe('costDeltaVsMainUSD in HTTP response', () => {
  it('costSummary.totalCostDeltaVsMainUSD is non-zero when main model has a known rate card', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-8',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'review', filePaths: ['/tmp/add.ts'] }),
      });
      expect(dispatch.status).toBe(202);
      const { taskId } = (await dispatch.json()) as { taskId: string };
      const envelope = (await pollToTerminal(h.baseUrl, h.token, taskId)) as {
        costSummary: {
          totalActualCostUSD: number;
          totalCostDeltaVsMainUSD: number | null;
          totalMainEquivalentUSD: number | null;
        };
        results: Array<{
          cost: {
            implementerUsd: number;
            reviewerUsd: number | null;
            mainEquivalentUsd: number | null;
            savedVsMainUsd: number | null;
          };
        }>;
      };

      // totalCostDeltaVsMainUSD should no longer be hardcoded 0
      // It should be non-null (claude-opus-4-8 has a known rate card)
      expect(envelope.costSummary.totalCostDeltaVsMainUSD).not.toBeNull();
      expect(typeof envelope.costSummary.totalCostDeltaVsMainUSD).toBe('number');

      // totalMainEquivalentUSD should be present and positive
      expect(envelope.costSummary.totalMainEquivalentUSD).not.toBeNull();
      expect(envelope.costSummary.totalMainEquivalentUSD).toBeGreaterThan(0);

      // The delta should equal mainEquivalent - actual
      if (envelope.costSummary.totalMainEquivalentUSD !== null) {
        expect(envelope.costSummary.totalCostDeltaVsMainUSD).toBeCloseTo(
          envelope.costSummary.totalMainEquivalentUSD - envelope.costSummary.totalActualCostUSD,
          6,
        );
      }

      // Per-result cost should also have the new fields
      const resultCost = envelope.results[0].cost;
      expect(resultCost.mainEquivalentUsd).not.toBeNull();
      expect(resultCost.savedVsMainUsd).not.toBeNull();
    } finally {
      await h.close();
    }
  }, 60_000);
});
