import { describe, expect, it } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function dispatch(h: { baseUrl: string; token: string }, body: object) {
  return fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: HEADERS(h.token),
    body: JSON.stringify(body),
  });
}

async function pollToTerminal(h: { baseUrl: string; token: string }, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
    if (res.status === 200) return (await res.json()) as Record<string, unknown>;
    if (res.status !== 202) throw new Error(`Unexpected ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timeout');
}

// AC-5.3: every target.paths entry must resolve before dispatch. An unresolvable
// entry (missing / unreadable / broken symlink) fails the task with invalid_request,
// and no worker is dispatched — see the Error-handling contract in the spec.
describe('spec/plan target.paths resolution guard', () => {
  it('fails a spec task with invalid_request when a target.paths entry does not resolve', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await dispatch(h, {
        type: 'spec',
        prompt: 'artifact stem inheritance smoke',
        target: { paths: ['.mma/this-path-does-not-exist-9f3a2b.md'] },
      });
      expect(res.status).toBe(202);
      const { taskId } = await res.json();
      const terminal = await pollToTerminal(h, taskId);
      expect(terminal.code).toBe('invalid_request');
      expect(terminal.message).toContain('this-path-does-not-exist-9f3a2b.md');
    } finally {
      await h.close();
    }
  });
});
