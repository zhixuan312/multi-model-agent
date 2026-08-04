// Contract: DELETE /task/:taskId — cooperative cancellation over the wire.
// 202 = cancellation REQUESTED (the task keeps running until the runner
// confirms termination); 200 alreadyTerminal = too late, final state stands;
// 404 = unknown id. Idempotent. Polls surface cancellationRequested while the
// runner winds down.
import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const HEADERS = (token: string) => ({
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function dispatch(h: { baseUrl: string; token: string }, body: object): Promise<string> {
  const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS(h.token) },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { taskId: string }).taskId;
}

async function pollUntilTerminal(h: { baseUrl: string; token: string }, taskId: string): Promise<unknown> {
  for (let i = 0; i < 300; i++) {
    const poll = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
    if (poll.status === 200) return poll.json();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${taskId}`);
}

describe('contract: DELETE /task/:taskId', () => {
  it('unknown task id → 404 not_found', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task/does-not-exist`, { method: 'DELETE', headers: HEADERS(h.token) });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    } finally { await h.close(); }
  });

  it('missing auth → 401 before any cancellation logic runs', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/task/whatever`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    } finally { await h.close(); }
  });

  it('terminal task → 200 alreadyTerminal, final state stands', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const taskId = await dispatch(h, { type: 'investigate', prompt: 'quick question' });
      await pollUntilTerminal(h, taskId);

      const res = await fetch(`${h.baseUrl}/task/${taskId}`, { method: 'DELETE', headers: HEADERS(h.token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { taskId: string; status: string; alreadyTerminal: boolean };
      expect(body.taskId).toBe(taskId);
      expect(body.alreadyTerminal).toBe(true);
      expect(['complete', 'failed']).toContain(body.status);

      // The terminal result is still retrievable — cancel did not disturb it.
      const after = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
      expect(after.status).toBe(200);
    } finally { await h.close(); }
  });

  it('running task → 202 requested, then terminal cancelled envelope; repeat DELETE reports terminal', async () => {
    // 'hang' turns block until the abort signal fires (then reject) — exactly
    // how a real runner reacts to killGracefully/SDK abort.
    const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
    try {
      const taskId = await dispatch(h, { type: 'investigate', prompt: 'this will hang' });

      // Let the executor start and the implementer turn begin hanging.
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${h.baseUrl}/task/${taskId}`, { method: 'DELETE', headers: HEADERS(h.token) });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { taskId: string; status: string; cancellationRequested: boolean };
      // Identity rides along on the cancel acknowledgement too — the same fields the MCP
      // wire returns, since both call taskIdentity().
      expect(body).toEqual({
        taskId, type: 'investigate', cwd: expect.any(String),
        status: 'running', cancellationRequested: true,
      });

      // The runner tears down and the task reaches terminal `cancelled` —
      // full wire lifecycle: 202 running → DELETE 202 → 200 cancelled.
      const terminal = (await pollUntilTerminal(h, taskId)) as {
        task: { taskId: string; status: string };
        error: { code: string };
      };
      expect(terminal.task.status).toBe('cancelled');
      expect(terminal.error.code).toBe('aborted');

      // Repeat DELETE after terminal: idempotent, reports the final state.
      const again = await fetch(`${h.baseUrl}/task/${taskId}`, { method: 'DELETE', headers: HEADERS(h.token) });
      expect(again.status).toBe(200);
      const againBody = (await again.json()) as { status: string; alreadyTerminal: boolean };
      expect(againBody.status).toBe('cancelled');
      expect(againBody.alreadyTerminal).toBe(true);
    } finally { await h.close(); }
  });
});
