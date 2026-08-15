import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const capturedQueries: Array<{ env?: Record<string, string>; hooks?: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  return {
    query: vi.fn((args: any) => {
      // `options` as well as the two named fields: the skills contract is about which keys are
      // PRESENT on the SDK options, which a projection of two of them cannot see.
      capturedQueries.push({ env: args.options?.env, hooks: args.options?.hooks, options: args.options });
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

  const sessionOpts = (taskId: string) => ({
    cwd: '/tmp',
    wallClockDeadline: Date.now() + 60000,
    abortSignal: new AbortController().signal,
    taskId,
    taskIndex: 0,
  }) as any;

  it('no baseUrl — key goes out as x-api-key only (Bearer is reserved for OAuth)', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;
    // Both are set here on purpose: asserting they are absent only proves scrubbing
    // if something was there to scrub. Left unset, this passes on a clean machine
    // and silently stops testing anything the moment an operator exports either.
    process.env.ANTHROPIC_AUTH_TOKEN = 'INHERITED-TOKEN';
    process.env.ANTHROPIC_BASE_URL = 'https://inherited.example';

    await new ClaudeSession({ model: 'm', opts: sessionOpts('direct'), apiKey: 'KEY' }).send('hi');

    const env = mockSdk.__capturedQueries[0].env;
    expect(env.ANTHROPIC_API_KEY).toBe('KEY');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // An inherited base URL would send the configured key to a host this session
    // never chose, with no Bearer header, so the turn hangs instead of erroring.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('baseUrl — key goes out as BOTH Bearer and x-api-key so any proxy finds its header', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    await new ClaudeSession({
      model: 'm',
      opts: sessionOpts('proxied'),
      apiKey: 'PROXY-KEY',
      baseUrl: 'https://ollama.com',
    }).send('hi');

    const env = mockSdk.__capturedQueries[0].env;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('PROXY-KEY');
    expect(env.ANTHROPIC_API_KEY).toBe('PROXY-KEY');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ollama.com');
  });

  it('baseUrl without a configured key — inherited ANTHROPIC_* never leaks to the proxy', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;
    process.env.ANTHROPIC_API_KEY = 'INHERITED-ANTHROPIC-KEY';
    process.env.ANTHROPIC_AUTH_TOKEN = 'INHERITED-TOKEN';

    await new ClaudeSession({
      model: 'm',
      opts: sessionOpts('proxied-nokey'),
      baseUrl: 'https://api.z.ai/api/anthropic',
    }).send('hi');

    const env = mockSdk.__capturedQueries[0].env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });

  it('OAuth subscription token wins and no inherited api key rides along', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;
    process.env.ANTHROPIC_API_KEY = 'INHERITED-ANTHROPIC-KEY';

    await new ClaudeSession({
      model: 'm',
      opts: sessionOpts('oauth'),
      oauthAccessToken: 'OAUTH-TOKEN',
    }).send('hi');

    const env = mockSdk.__capturedQueries[0].env;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('OAUTH-TOKEN');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
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

  /**
   * Skills are default-OFF, and "off" means the keys are absent rather than empty.
   *
   * `claude-session.ts` spreads `buildClaudeSkillOptions(...)` only when a bundle exists and
   * `{}` otherwise, so a worker with no bundle inherits the host's own settings and skills. An
   * empty `skills: []` with `settingSources: []` would be a different thing entirely — an
   * explicit isolation the caller never asked for. `claude-skill-plugin.test.ts` asserted the
   * helper's key list and called that the default-off contract; the helper is not what decides
   * it, this is.
   */
  it('sends NO skills/plugins/settingSources keys when the session has no skill bundle', async () => {
    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sess = new ClaudeSession({
      model: 'm',
      opts: { cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, taskId: 'noskills', taskIndex: 0 } as any,
    });
    await sess.send('test');

    const options = mockSdk.__capturedQueries[0].options;
    expect(options).not.toHaveProperty('skills');
    expect(options).not.toHaveProperty('plugins');
    expect(options).not.toHaveProperty('settingSources');
  });

  it('sends the isolated plugin bundle when the session HAS one', async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stagedRoot = await mkdtemp(join(tmpdir(), 'mma-skills-'));
    await mkdir(join(stagedRoot, 'skills', 'audit'), { recursive: true });

    const mockSdk = await import('@anthropic-ai/claude-agent-sdk') as any;
    mockSdk.__capturedQueries.length = 0;

    const sess = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal,
        taskId: 'skills', taskIndex: 0, skills: { stagedRoot, names: ['audit'] },
      } as any,
    });
    await sess.send('test');

    const options = mockSdk.__capturedQueries[0].options;
    expect(options.skills).toEqual(['audit']);
    expect(options.plugins).toEqual([{ type: 'local', path: stagedRoot }]);
    // The SDK's isolation mode: no user or project settings leak into the worker.
    expect(options.settingSources).toEqual([]);
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
