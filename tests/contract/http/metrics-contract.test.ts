import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

async function dispatchAndPoll(h: { baseUrl: string; token: string }, body: object): Promise<{ taskId: string; polling: unknown; terminal: unknown }> {
  const dispatch = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MMA-Main-Model': 'claude-opus-4-8',
      'X-MMA-Client': 'claude-code',
      Authorization: `Bearer ${h.token}`,
    },
    body: JSON.stringify(body),
  });
  expect(dispatch.status).toBe(202);
  const { taskId } = (await dispatch.json()) as { taskId: string };

  let polling: unknown = null;
  for (let i = 0; i < 300; i++) {
    const poll = await fetch(`${h.baseUrl}/task/${taskId}`, {
      headers: { 'X-MMA-Main-Model': 'claude-opus-4-8', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${h.token}` },
    });
    if (poll.status === 200) return { taskId, polling, terminal: await poll.json() };
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    if (!polling) polling = await poll.json();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${taskId}`);
}

describe('metrics contract', () => {
  it('totalCostUsd = implementer + reviewer, and savedVsMainCostUsd = mainEquivalent - total', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const { terminal } = await dispatchAndPoll(h, { type: 'review', target: { paths: ['/tmp/add.ts'] } });
      const env = terminal as { metrics: Record<string, unknown> };
      const m = env.metrics as {
        totalCostUsd: number;
        implementer: { costUsd: number };
        reviewer: { costUsd: number } | null;
        mainEquivalentCostUsd: number | null;
        savedVsMainCostUsd: number | null;
      };

      const implCost = m.implementer.costUsd;
      const revCost = m.reviewer?.costUsd ?? 0;
      expect(m.totalCostUsd).toBeCloseTo(implCost + revCost, 6);

      expect(m.mainEquivalentCostUsd).not.toBeNull();
      expect(m.savedVsMainCostUsd).not.toBeNull();
      if (m.mainEquivalentCostUsd !== null) {
        expect(m.savedVsMainCostUsd).toBeCloseTo(m.mainEquivalentCostUsd - m.totalCostUsd, 6);
      }
    } finally {
      await h.close();
    }
  }, 60_000);
}, 60_000);
