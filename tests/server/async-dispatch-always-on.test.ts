import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestServerWithAgents } from '../helpers/test-server-with-agents.js';

describe('async-dispatch — always-on breadcrumbs (A5)', () => {
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

  it('emits executor_started and batch_completed to stderr with diagnostics.log=false', async () => {
    const handle = await startTestServerWithAgents({ diagnostics: { log: false }, defaults: { timeoutMs: 100, tools: 'full', sandboxPolicy: 'cwd-only' } });
    try {
      await fetch(`${handle.url}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          'Authorization': `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'noop' }] }),
      });
      // Allow async-dispatch to flush and executor to complete.
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      await handle.stop();
    }
    const joined = stderrCalls.join('');
    expect(joined).toMatch(/event=executor_started /);
    // batch ends in either batch_completed (success) or batch_failed (since the
    // mock baseUrl is invalid). Accept either.
    expect(joined).toMatch(/event=batch_(completed|failed) /);
    // Direct-write paths must no longer touch stdout for these breadcrumbs.
    expect(stdoutCalls.join('')).not.toMatch(/event=(executor_started|batch_completed|batch_failed) /);
  });
});
