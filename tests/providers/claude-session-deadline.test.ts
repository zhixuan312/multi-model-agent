import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

// A hanging SDK query: next() never resolves until close() is called (which the
// wall-clock deadline timer triggers). This lets us assert that a turn with an
// elapsed deadline returns bounded (terminationReason=time_exceeded) instead of
// running forever.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(() => {
      let closed = false;
      let unblock: (() => void) | null = null;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (closed) return { value: undefined, done: true };
              // Hang until close() is called by the deadline timer.
              await new Promise<void>((resolve) => { unblock = resolve; });
              return { value: undefined, done: true };
            },
          };
        },
        close() {
          closed = true;
          if (unblock) unblock();
        },
      };
    }),
  };
});

describe('ClaudeSession — wall-clock deadline', () => {
  it('force-closes the query and reports terminationReason=time_exceeded when the deadline elapses', async () => {
    const session = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/tmp',
        wallClockDeadline: Date.now() + 20, // 20ms budget → deadline fires fast
        abortSignal: new AbortController().signal,
        taskId: 'T',
        taskIndex: 0,
      } as any,
    });

    const result = await session.send('hang please');

    expect(result.terminationReason).toBe('time_exceeded');
    expect(result.errorCode).toBe('wall_clock_exceeded');
  });
});
