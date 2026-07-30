// ClaudeSession — caller cancellation must force-close the SDK query, not
// merely hand the signal to the SDK and wait for it to finish the in-flight
// turn. Measured live: without the force-close, a cancelled task kept billing
// tokens ~48s. This is the claude-side equivalent of the codex runner's
// process-group kill.
import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

// A hanging SDK query: next() never resolves until close() is called. If the
// session did not force-close on abort, these tests would hang until the
// wall-clock deadline (set far in the future here) instead of returning.
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

function makeSession(signal: AbortSignal, deadlineMs = 3_600_000): ClaudeSession {
  return new ClaudeSession({
    model: 'm',
    opts: {
      cwd: '/tmp',
      // Far-future deadline: only cancellation can end these turns, so a pass
      // proves the abort path — not the deadline guard — did the work.
      wallClockDeadline: Date.now() + deadlineMs,
      abortSignal: signal,
      taskId: 'T',
      taskIndex: 0,
    } as never,
  });
}

describe('ClaudeSession — caller cancellation', () => {
  it('force-closes the query and reports terminationReason=aborted when the signal fires mid-turn', async () => {
    const ac = new AbortController();
    const session = makeSession(ac.signal);

    const turn = session.send('hang please');
    // Fire after the turn is in flight — the realistic cancellation window.
    setTimeout(() => ac.abort('caller cancelled'), 20);
    const result = await turn;

    expect(result.terminationReason).toBe('aborted');
    expect(result.errorCode).toBe('aborted');
  });

  it('honours a signal that is already aborted before send()', async () => {
    const ac = new AbortController();
    ac.abort('cancelled before dispatch');
    const session = makeSession(ac.signal);

    const result = await session.send('should not run');

    expect(result.terminationReason).toBe('aborted');
    expect(result.errorCode).toBe('aborted');
  });

  it('cancellation outranks the deadline when both fire', async () => {
    const ac = new AbortController();
    // 20ms deadline AND an abort — the caller's intent is the actionable reason.
    const session = makeSession(ac.signal, 20);
    ac.abort();

    const result = await session.send('hang please');

    expect(result.terminationReason).toBe('aborted');
    expect(result.errorCode).toBe('aborted');
  });

  it('a force-closed stream never reports ok (no dead-turn masquerade)', async () => {
    const ac = new AbortController();
    const session = makeSession(ac.signal);
    const turn = session.send('hang please');
    setTimeout(() => ac.abort(), 10);
    const result = await turn;

    // The stream produced no result event; the guard reason must win over any
    // default, so this can never be mistaken for a successful turn.
    expect(result.terminationReason).not.toBe('ok');
    expect(result.output).toBe('');
  });
});
