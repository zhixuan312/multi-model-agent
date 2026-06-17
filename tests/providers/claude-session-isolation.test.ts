import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const capturedQueries: Array<{ env?: Record<string, string>; hooks?: Record<string, unknown> }> = [];
  return {
    query: vi.fn((args: any) => {
      capturedQueries.push({ env: args.options?.env, hooks: args.options?.hooks });
      // return a minimal async iterable that yields one result event then ends
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { value: undefined, done: true };
              done = true;
              return { value: { type: 'result', subtype: 'success', result: '', session_id: 'x', usage: {} }, done: false };
            },
          };
        },
        close() {},
      };
    }),
    __capturedQueries: capturedQueries,
  };
});

describe('ClaudeSession — per-call env isolation (D3 A3.2 / A3.3)', () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('A3.2 — two concurrent sessions with distinct apiKey each call SDK with their own key', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sessA = new ClaudeSession({ model: 'm', opts: { cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, taskId: 'B', taskIndex: 0 } as any, apiKey: 'KEY-A' });
    const sessB = new ClaudeSession({ model: 'm', opts: { cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, taskId: 'B', taskIndex: 1 } as any, apiKey: 'KEY-B' });

    await Promise.all([sessA.send('hi-a'), sessB.send('hi-b')]);

    const keys = mockSdk.__capturedQueries.map((q: any) => q.env?.ANTHROPIC_API_KEY).filter(Boolean).sort();
    expect(keys).toEqual(['KEY-A', 'KEY-B']);
  });

  it('cwd-only sandboxPolicy wires PreToolUse confinement hook into SDK query', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sess = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/project/repo',
        wallClockDeadline: Date.now() + 60000,
        abortSignal: new AbortController().signal,
        taskId: 'conf-test',
        taskIndex: 0,
        sandboxPolicy: 'cwd-only',
      } as any,
    });
    await sess.send('test');

    const q = mockSdk.__capturedQueries[0];
    expect(q.hooks).toBeDefined();
    expect(q.hooks.PreToolUse).toBeDefined();
    expect(q.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(q.hooks.PreToolUse[0].hooks).toBeInstanceOf(Array);

    // Verify the hook denies writes outside cwd
    const hookFn = q.hooks.PreToolUse[0].hooks[0];
    const denyResult = await hookFn({ tool_name: 'Write', tool_input: { file_path: '/outside/f.ts' } });
    expect(denyResult.hookSpecificOutput?.permissionDecision).toBe('deny');

    // Verify the hook allows writes inside cwd
    const allowResult = await hookFn({ tool_name: 'Write', tool_input: { file_path: '/project/repo/src/f.ts' } });
    expect(allowResult.hookSpecificOutput).toBeUndefined();

    // Verify reads are unrestricted
    const readResult = await hookFn({ tool_name: 'Read', tool_input: { file_path: '/anywhere/f.ts' } });
    expect(readResult.hookSpecificOutput).toBeUndefined();
  });

  it('read-only sandboxPolicy wires PreToolUse hook that blocks ALL writes', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sess = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/project/repo',
        wallClockDeadline: Date.now() + 60000,
        abortSignal: new AbortController().signal,
        taskId: 'ro-test',
        taskIndex: 0,
        sandboxPolicy: 'read-only',
      } as any,
    });
    await sess.send('test');

    const q = mockSdk.__capturedQueries[0];
    expect(q.hooks).toBeDefined();
    expect(q.hooks.PreToolUse).toBeDefined();

    const hookFn = q.hooks.PreToolUse[0].hooks[0];

    // Denies writes even inside cwd
    const writeInside = await hookFn({ tool_name: 'Write', tool_input: { file_path: '/project/repo/inside.ts' } });
    expect(writeInside.hookSpecificOutput?.permissionDecision).toBe('deny');

    // Denies Edit even inside cwd
    const editInside = await hookFn({ tool_name: 'Edit', tool_input: { file_path: '/project/repo/inside.ts' } });
    expect(editInside.hookSpecificOutput?.permissionDecision).toBe('deny');

    // Denies Bash with mutating commands
    const bashMutate = await hookFn({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } });
    expect(bashMutate.hookSpecificOutput?.permissionDecision).toBe('deny');

    // Allows reads anywhere
    const readOutside = await hookFn({ tool_name: 'Read', tool_input: { file_path: '/anywhere/f.ts' } });
    expect(readOutside.hookSpecificOutput).toBeUndefined();

    // Allows read-only Bash
    const bashRead = await hookFn({ tool_name: 'Bash', tool_input: { command: 'cat /etc/hosts' } });
    expect(bashRead.hookSpecificOutput).toBeUndefined();
  });

  it('no sandboxPolicy = no PreToolUse hook', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sess = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/project/repo',
        wallClockDeadline: Date.now() + 60000,
        abortSignal: new AbortController().signal,
        taskId: 'no-sandbox',
        taskIndex: 0,
      } as any,
    });
    await sess.send('test');

    const q = mockSdk.__capturedQueries[0];
    // No hooks at all when no sandboxPolicy
    expect(q.hooks).toBeUndefined();
  });

  it('A3.3 — process.env.ANTHROPIC_* unchanged after concurrent sessions', async () => {
    const before = {
      a: process.env.ANTHROPIC_API_KEY,
      b: process.env.ANTHROPIC_BASE_URL,
      t: process.env.ANTHROPIC_AUTH_TOKEN,
    };

    const sessA = new ClaudeSession({ model: 'm', opts: { cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, taskId: 'B', taskIndex: 0 } as any, apiKey: 'KEY-A', baseUrl: 'https://a.example' });
    const sessB = new ClaudeSession({ model: 'm', opts: { cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, taskId: 'B', taskIndex: 1 } as any, apiKey: 'KEY-B' });

    await Promise.all([sessA.send('hi-a'), sessB.send('hi-b')]);

    expect(process.env.ANTHROPIC_API_KEY).toBe(before.a);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before.b);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before.t);
  });
});
