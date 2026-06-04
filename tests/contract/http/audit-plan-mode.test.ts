import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '..', 'fixtures', 'plan-with-symbol-drift.md');

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<unknown> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return await poll.json();
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

describe('contract: POST /audit { subtype: "plan" } end-to-end', () => {
  it('accepts subtype=plan with a single filePaths entry and returns a terminal envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const dispatch = await fetch(`${h.baseUrl}/audit?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ subtype: 'plan', filePaths: [FIXTURE_PATH] }),
      });
      expect(dispatch.status).toBe(202);
      const { batchId } = (await dispatch.json()) as { batchId: string };
      const env = await pollToTerminal(h.baseUrl, h.token, batchId);
      expect(env).toHaveProperty('results');
      expect(env).toHaveProperty('headline');
    } finally {
      await h.close();
    }
  }, 60_000);

  it('rejects auditType=plan with !==1 filePaths', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const r = await fetch(`${h.baseUrl}/audit?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ subtype: 'plan', filePaths: [FIXTURE_PATH, FIXTURE_PATH] }),
      });
      expect(r.status).toBe(400);
    } finally {
      await h.close();
    }
  }, 30_000);
});
