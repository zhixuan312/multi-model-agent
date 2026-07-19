import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
    method: 'POST', headers: HEADERS(h.token), body: JSON.stringify(body),
  });
}

async function poll202(h: { baseUrl: string; token: string }, taskId: string) {
  const res = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
  return { status: res.status, body: await res.json(), contentType: res.headers.get('content-type') };
}

async function pollToTerminal(h: { baseUrl: string; token: string }, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
    if (res.status === 200) return (await res.json()) as Record<string, unknown>;
    if (res.status !== 202) throw new Error(`Unexpected ${res.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

describe('route contract', () => {
  // ── Dispatch receipt (POST /task → 202) ──

  describe('POST /task dispatch receipt', () => {
    it('returns 202 with taskId and statusUrl', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        expect(res.status).toBe(202);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.taskId).toBeTypeOf('string');
        expect(body.statusUrl).toMatch(/^\/task\//);
      } finally { await h.close(); }
    });
  });

  // ── Structured 202 polling ──

  describe('GET /task/:taskId polling (202)', () => {
    it('returns structured JSON with taskId, status, phase, elapsedMs, phaseElapsedMs, startedAt', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const poll = await poll202(h, taskId);
        if (poll.status === 202) {
          expect(poll.contentType).toContain('application/json');
          const b = poll.body as Record<string, unknown>;
          expect(b.taskId).toBe(taskId);
          expect(b.status).toBe('running');
          expect(b.phase).toBeTypeOf('string');
          expect(b.elapsedMs).toBeTypeOf('number');
          expect(b.phaseElapsedMs).toBeTypeOf('number');
          expect(b.startedAt).toBeTypeOf('string');
        }
      } finally { await h.close(); }
    });
  });

  // ── Layered 200 terminal shape ──

  describe('GET /task/:taskId terminal (200)', () => {
    it('has exactly: task, output, execution, metrics, raw, error', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        expect(Object.keys(env).sort()).toEqual(['error', 'execution', 'metrics', 'output', 'raw', 'task']);
      } finally { await h.close(); }
    });

    it('task block has taskId, type, status', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        const task = env.task as Record<string, unknown>;
        expect(task.taskId).toBe(taskId);
        expect(task.type).toBe('review');
        expect(['done', 'done_with_concerns', 'failed']).toContain(task.status);
      } finally { await h.close(); }
    });

    it('task.subtype present for audit, absent for other routes', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const r1 = await dispatch(h, { type: 'audit', subtype: 'spec', target: { paths: ['/tmp/a.md'] } });
        const { taskId: t1 } = (await r1.json()) as { taskId: string };
        const env1 = await pollToTerminal(h, t1);
        expect((env1.task as Record<string, unknown>).subtype).toBe('spec');

        const r2 = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId: t2 } = (await r2.json()) as { taskId: string };
        const env2 = await pollToTerminal(h, t2);
        expect((env2.task as Record<string, unknown>).subtype).toBeUndefined();
      } finally { await h.close(); }
    });

    it('output block has summary, filesChanged, contextBlockId', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        const out = env.output as Record<string, unknown>;
        expect(out).toHaveProperty('summary');
        expect(out).toHaveProperty('filesChanged');
        expect(out).toHaveProperty('contextBlockId');
      } finally { await h.close(); }
    });

    it('metrics includes token usage per phase and total', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        const m = env.metrics as Record<string, unknown>;
        expect(m).toHaveProperty('totalUsage');
        const impl = m.implementer as Record<string, unknown>;
        expect(impl).toHaveProperty('usage');
        const usage = impl.usage as Record<string, unknown>;
        expect(usage).toHaveProperty('inputTokens');
        expect(usage).toHaveProperty('outputTokens');
      } finally { await h.close(); }
    });

    it('error is null when reviewer parses successfully, or has code when parse fails', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        const task = env.task as Record<string, unknown>;
        if (task.status === 'done') {
          expect(env.error).toBeNull();
        } else if (task.status === 'done_with_concerns') {
          expect(env.error).toMatchObject({ code: 'reviewer_parse_failed' });
        }
      } finally { await h.close(); }
    });

    it('execution.worktree is null for read routes', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); }
    });
  });

  // ── Input validation ──

  describe('input validation', () => {
    it('rejects deprecated question field with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'investigate', question: 'test' });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });

    it('rejects deprecated errorMessage field with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'debug', errorMessage: 'test' });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });

    it('rejects deprecated filePaths field with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'audit', filePaths: ['a.md'] });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });

    it('rejects deprecated taskDescriptors field with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'execute_plan', filePaths: ['p.md'], taskDescriptors: ['1'] });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });

    it('rejects unknown task type with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'bogus', prompt: 'test' });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });

    it('accepts delegate flat shape (prompt, not tasks array)', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'delegate', prompt: 'do something' });
        expect(res.status).toBe(202);
      } finally { await h.close(); }
    });

    it('rejects old delegate tasks array with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'delegate', tasks: [{ prompt: 'x' }] });
        expect(res.status).toBe(400);
      } finally { await h.close(); }
    });
  });

  // ── Unknown taskId ──

  describe('unknown taskId', () => {
    it('returns 404 for nonexistent taskId', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await fetch(`${h.baseUrl}/task/00000000-0000-0000-0000-000000000000`, {
          headers: HEADERS(h.token),
        });
        expect(res.status).toBe(404);
      } finally { await h.close(); }
    });
  });

  // ── Non-git targets: write routes run in-place, worktree stays null (optional worktree) ──

  describe('non-git write-route execution', () => {
    it('delegate keeps execution.worktree null for a non-git cwd target', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-nongit-'));   // no .git created
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'delegate', prompt: 'touch a note' }),
        });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('execute_plan runs in-place (worktree null) for a non-git cwd target', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-nongit-ep-'));
      await writeFile(join(tmp, 'plan.md'), '# Plan\n\n### Task 1: noop\n\n- [ ] Step 1: do nothing\n');
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'execute_plan', target: { paths: ['plan.md'] } }),
        });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('delegate still creates a worktree (non-null) for a git cwd target — no regression', async () => {
      // Isolated temp git repo (not the engine repo) so the git path is exercised deterministically.
      const tmp = await mkdtemp(join(tmpdir(), 'mma-git-'));
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp });
      await writeFile(join(tmp, 'f.txt'), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: tmp });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'delegate', prompt: 'touch a note' }),
        });
        const { taskId } = (await res.json()) as { taskId: string };
        const env = await pollToTerminal(h, taskId);
        expect((env.execution as Record<string, unknown>).worktree).not.toBeNull();
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });
  });
}, 60_000);
