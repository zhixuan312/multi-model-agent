/**
 * `mma execution wait` — the blocking wait an agent can hand to its own harness.
 *
 * An agent has no existence between turns. `mma_execution_wait` over MCP is capped at 55s by the
 * client's request deadline, so any longer task needs a polling LOOP, and a loop needs a caller
 * that is still executing. Nothing wakes an agent for an mma task either: the daemon owns the
 * execution, so the client's task tracking has no handle on it and can send no notification.
 *
 * A blocking CLI command converts that untracked wait into a tracked one — a background job the
 * harness owns and whose exit it notices.
 *
 * The cases below are shaped by a real incident. An agent hand-rolled the poller as
 * `curl -s "…/execution/$ID" | parse .status`, with no Authorization header. Every request
 * returned 401; `curl -s` without `-f` emitted the error body; the parser found no `status` field;
 * the loop read that as "not terminal" and kept going. It polled a 401 for two hours and reported a
 * false timeout while both executions had long since completed.
 *
 * So the two properties that matter most here are not the happy path:
 *   - a non-2xx response EXITS, and never loops
 *   - a timeout says the execution is still running and was NOT cancelled
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutionWait } from '../../packages/server/src/cli/execution-wait.js';

function withToken<T>(fn: (tokenFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mma-wait-cli-'));
  try {
    const f = join(dir, 'auth-token');
    writeFileSync(f, 'test-token\n');
    return fn(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fetch stub returning a scripted sequence of responses. */
function scripted(steps: { status: number; body: unknown }[]): {
  fetchFn: typeof fetch;
  calls: () => number;
  lastHeaders: () => Record<string, string>;
} {
  let i = 0;
  let headers: Record<string, string> = {};
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => i, lastHeaders: () => headers };
}

const noSleep = async (): Promise<void> => {};

describe('mma execution wait — terminal states', () => {
  it.each([
    ['completed', 0],
    ['done_with_concerns', 0],
    // `done` is what a live daemon actually returned, and it was NOT in the first version's
    // terminal-name list — so the command waited out its full timeout on finished work. Kept as a
    // case because the name list was the bug.
    ['done', 0],
    ['failed', 1],
    ['cancelled', 1],
    ['interrupted', 1],
  ])('%s exits %i', async (status, expected) => {
    await withToken(async (tokenFile) => {
      const { fetchFn } = scripted([{ status: 200, body: { execution: { status } } }]);
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(code).toBe(expected);
    });
  });

  it('treats an UNRECOGNISED terminal state as terminal, on the HTTP signal alone', async () => {
    // The whole point of keying on 202-vs-200: a state name this command has never heard of must
    // still end the wait. Enumerating names is what made a finished execution look unfinished.
    await withToken(async (tokenFile) => {
      const { fetchFn } = scripted([{ status: 200, body: { execution: { status: 'some-future-state' } } }]);
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(code, 'an unknown terminal state must exit 0, not hang or report failure').toBe(0);
    });
  });

  it('polls while running, then returns the terminal code', async () => {
    await withToken(async (tokenFile) => {
      const { fetchFn, calls } = scripted([
        { status: 202, body: { execution: { status: 'running' } } },
        { status: 202, body: { execution: { status: 'running' } } },
        { status: 200, body: { execution: { status: 'completed' } } },
      ]);
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(code).toBe(0);
      expect(calls(), 'it must actually have polled more than once').toBe(3);
    });
  });
});

describe('mma execution wait — the incident this command exists to prevent', () => {
  it('EXITS on 401 instead of looping on it', async () => {
    await withToken(async (tokenFile) => {
      const { fetchFn, calls } = scripted([
        { status: 401, body: { error: { code: 'unauthorized', message: 'Valid Bearer token required' } } },
      ]);
      let stderr = '';
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: (s) => { stderr += s; return true; },
      });
      expect(code, 'a 401 must not be read as "still running"').toBe(4);
      expect(calls(), 'it must not have polled the error more than once').toBe(1);
      expect(stderr).toContain('401');
    });
  });

  it('EXITS on 404 for an unknown execution id', async () => {
    await withToken(async (tokenFile) => {
      const { fetchFn } = scripted([{ status: 404, body: { error: { code: 'not_found' } } }]);
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'nope',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(code).toBe(4);
    });
  });

  it('EXITS when the daemon is unreachable, rather than waiting out the timeout', async () => {
    await withToken(async (tokenFile) => {
      const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      let stderr = '';
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: (s) => { stderr += s; return true; },
      });
      expect(code).toBe(4);
      expect(stderr).toContain('cannot reach');
    });
  });

  it('sends the Authorization header, which the hand-rolled poller omitted', async () => {
    await withToken(async (tokenFile) => {
      const { fetchFn, lastHeaders } = scripted([{ status: 200, body: { execution: { status: 'completed' } } }]);
      await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        fetchFn, sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(lastHeaders()['Authorization']).toBe('Bearer test-token');
    });
  });

  it('a missing token file is an error, not an unauthenticated request', async () => {
    const code = await runExecutionWait({
      serverUrl: 'http://127.0.0.1:7337', tokenFile: '/definitely/not/here/auth-token',
      executionId: 'e1', sleep: noSleep, stdout: () => true, stderr: () => true,
    });
    expect(code).toBe(4);
  });
});

describe('mma execution wait — a timeout is not a failure', () => {
  it('exits 3 and says the execution is still running and uncancelled', async () => {
    await withToken(async (tokenFile) => {
      const { fetchFn } = scripted([{ status: 202, body: { execution: { status: 'running' } } }]);
      let t = 0;
      let stderr = '';
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: 'e1',
        timeoutSec: 10, fetchFn, sleep: noSleep,
        now: () => { t += 6000; return t; },   // two ticks and the budget is spent
        stdout: () => true, stderr: (s) => { stderr += s; return true; },
      });
      expect(code, 'a timeout must be distinguishable from a failed execution').toBe(3);
      expect(stderr, 'a caller that reads this must not re-dispatch').toMatch(/still running|UNAFFECTED/i);
      expect(stderr).toMatch(/nothing was cancelled/i);
    });
  });
});

describe('mma execution wait — usage', () => {
  it('exits 2 without an executionId', async () => {
    await withToken(async (tokenFile) => {
      const code = await runExecutionWait({
        serverUrl: 'http://127.0.0.1:7337', tokenFile, executionId: '',
        sleep: noSleep, stdout: () => true, stderr: () => true,
      });
      expect(code).toBe(2);
    });
  });
});
