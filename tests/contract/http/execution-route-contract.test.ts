import { describe, expect, it } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });

describe('execution route contract', () => {
  it('publishes execution receipt names and no task-route alias', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const created = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] } }) });
      expect(created.status).toBe(202);
      const receipt = (await created.json()) as { executionId: string; statusUrl: string };
      expect(receipt.executionId).toEqual(expect.any(String));
      expect(receipt.statusUrl).toBe(`/execution/${receipt.executionId}`);
      expect(await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: '{}' })).toMatchObject({ status: 404 });
    } finally { await h.close(); }
  });
});