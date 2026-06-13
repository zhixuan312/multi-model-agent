import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const capturedQueries: Array<{ env?: Record<string, string> }> = [];
  return {
    query: vi.fn((args: any) => {
      capturedQueries.push({ env: args.options?.env });
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
