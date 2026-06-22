import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

async function pollToTerminal(baseUrl: string, token: string, taskId: string): Promise<unknown> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/task/${taskId}`, {
      headers: { 'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return await poll.json();
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${taskId}`);
}

describe('A11.2 public-envelope cost roll-up', () => {
  it('metrics.totalCostUsd equals sum of implementer + reviewer costs', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-7',
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
          implementer: { costUsd: number };
          reviewer: { costUsd: number } | null;
        };
      };

      const implCost = envelope.metrics.implementer.costUsd;
      const revCost = envelope.metrics.reviewer?.costUsd ?? 0;
      expect(envelope.metrics.totalCostUsd).toBeCloseTo(implCost + revCost, 6);
    } finally {
      await h.close();
    }
  }, 60_000);
});
