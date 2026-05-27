import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

// Inject a fake SDK query via ClaudeSession's queryFn arg instead of
// mock.module('@anthropic-ai/claude-agent-sdk') — under Bun mock.module is
// process-global and sticky, so mocking the SDK leaked into every later
// claude-provider test (env isolation, safety-ceiling, etc.).
function makeFakeQuery(captured: Array<{ env?: Record<string, string> }>) {
  return ((args: any) => {
    captured.push({ env: args.options?.env });
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
  }) as any;
}

const baseOpts = () => ({ cwd: '/tmp', wallClockDeadline: Date.now() + 60000, abortSignal: new AbortController().signal, batchId: 'B' } as any);

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
    const captured: Array<{ env?: Record<string, string> }> = [];
    const queryFn = makeFakeQuery(captured);

    const sessA = new ClaudeSession({ model: 'm', opts: { ...baseOpts(), taskIndex: 0 }, apiKey: 'KEY-A', queryFn });
    const sessB = new ClaudeSession({ model: 'm', opts: { ...baseOpts(), taskIndex: 1 }, apiKey: 'KEY-B', queryFn });

    await Promise.all([sessA.send('hi-a'), sessB.send('hi-b')]);

    const keys = captured.map((q) => q.env?.ANTHROPIC_API_KEY).filter(Boolean).sort();
    expect(keys).toEqual(['KEY-A', 'KEY-B']);
  });

  it('A3.3 — process.env.ANTHROPIC_* unchanged after concurrent sessions', async () => {
    const before = {
      a: process.env.ANTHROPIC_API_KEY,
      b: process.env.ANTHROPIC_BASE_URL,
      t: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    const queryFn = makeFakeQuery([]);

    const sessA = new ClaudeSession({ model: 'm', opts: { ...baseOpts(), taskIndex: 0 }, apiKey: 'KEY-A', baseUrl: 'https://a.example', queryFn });
    const sessB = new ClaudeSession({ model: 'm', opts: { ...baseOpts(), taskIndex: 1 }, apiKey: 'KEY-B', queryFn });

    await Promise.all([sessA.send('hi-a'), sessB.send('hi-b')]);

    expect(process.env.ANTHROPIC_API_KEY).toBe(before.a);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before.b);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before.t);
  });
});
