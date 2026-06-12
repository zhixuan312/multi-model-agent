import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestServerWithAgents } from '../helpers/test-server-with-agents.js';

describe('task dispatch — always-on breadcrumbs (A5)', () => {
  let stderrCalls: string[] = [];
  let stdoutCalls: string[] = [];
  let originalStderr: typeof process.stderr.write;
  let originalStdout: typeof process.stdout.write;

  beforeEach(() => {
    stderrCalls = []; stdoutCalls = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    originalStdout = process.stdout.write.bind(process.stdout);
    (process.stderr.write as any) = (s: string) => { stderrCalls.push(s); return true; };
    (process.stdout.write as any) = (s: string) => { stdoutCalls.push(s); return true; };
  });
  afterEach(() => {
    (process.stderr.write as any) = originalStderr;
    (process.stdout.write as any) = originalStdout;
  });

  // TODO: Re-enable once a single-dispatch write route is available (old delegate
  // route removed in unified-task migration; remaining read-only routes run
  // sequential criteria that exceed the mock-provider timeout in CI).
  it.skip('emits executor_started and task_completed to stderr with diagnostics.log=false', async () => {
    const handle = await startTestServerWithAgents({ diagnostics: { log: false }, defaults: { timeoutMs: 100, tools: 'full', sandboxPolicy: 'cwd-only' } });
    try {
      await fetch(`${handle.url}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          'Authorization': `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'investigate', question: 'noop test' }),
      });
      // Allow task dispatch to flush and executor to complete.
      await new Promise((r) => setTimeout(r, 12000));
    } finally {
      await handle.stop();
    }
    const joined = stderrCalls.join('');
    expect(joined).toMatch(/event=executor_started /);
    // Task ends in either task_completed (success) or task_failed (since the
    // mock baseUrl is invalid). Accept either.
    expect(joined).toMatch(/event=task_(completed|failed) /);
    // Direct-write paths must no longer touch stdout for these breadcrumbs.
    expect(stdoutCalls.join('')).not.toMatch(/event=(executor_started|task_completed|task_failed) /);
  }, 30_000);
});
