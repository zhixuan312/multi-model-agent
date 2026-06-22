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
  it('metrics.savedVsMainCostUsd is non-zero when main model has a known rate card', async () => {
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
        body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/add.ts'] } }),
      });
      expect(dispatch.status).toBe(202);
      const { taskId } = (await dispatch.json()) as { taskId: string };
      const envelope = (await pollToTerminal(h.baseUrl, h.token, taskId)) as {
        metrics: {
          totalCostUsd: number;
          mainEquivalentCostUsd: number | null;
          savedVsMainCostUsd: number | null;
          implementer: { costUsd: number };
          reviewer: { costUsd: number } | null;
        };
      };

      expect(envelope.metrics.savedVsMainCostUsd).not.toBeNull();
      expect(typeof envelope.metrics.savedVsMainCostUsd).toBe('number');

      expect(envelope.metrics.mainEquivalentCostUsd).not.toBeNull();
      expect(envelope.metrics.mainEquivalentCostUsd).toBeGreaterThan(0);

      if (envelope.metrics.mainEquivalentCostUsd !== null) {
        expect(envelope.metrics.savedVsMainCostUsd).toBeCloseTo(
          envelope.metrics.mainEquivalentCostUsd - envelope.metrics.totalCostUsd,
          6,
        );
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});
