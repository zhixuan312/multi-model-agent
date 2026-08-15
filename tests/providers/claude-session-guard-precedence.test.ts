// Which reason a turn reports when BOTH guards fired — the deadline elapsed and the caller
// cancelled — is a real race in production: a cancel arriving in the window between the
// deadline's `close()` and the event loop finishing is all it takes.
//
// `claude-session-abort.test.ts` claimed to cover this by pairing an already-aborted signal
// with a 20ms deadline. It could not: the abort is checked synchronously inside `send()`, so
// the query closed and the iterator finished in the first microtask turn, long before any
// timer ran. `timedOut` stayed false and the precedence branch was never evaluated — the test
// asserted the abort path a second time under the name of the tie-break. Flipping the
// precedence in production left it green.
//
// Deterministic here because the mock decides when the turn ends: close() records the call but
// does NOT release the iterator, so the test can let the deadline fire, then cancel, and only
// then let the stream finish — with both flags genuinely set.
import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

interface HeldTurn { release: (() => void) | null; closes: number }
const held: HeldTurn = { release: null, closes: 0 };

// Through functions, not `held.release?.()` at the call site: assigning `null` in a test body
// narrows the property for the rest of that block, so tsc reads every later call as
// unreachable. The narrowing does not cross a function boundary.
function resetHeldTurn(): void { held.release = null; held.closes = 0; }
function releaseHeldTurn(): void { held.release?.(); }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          await new Promise<void>((resolve) => { held.release = resolve; });
          return { value: undefined, done: true };
        },
      };
    },
    close() { held.closes += 1; },
  })),
}));

const tick = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

describe('ClaudeSession — guard precedence when both fire', () => {
  it('reports the CANCELLATION, not the deadline, when the caller cancels as time runs out', async () => {
    resetHeldTurn();
    const ac = new AbortController();
    const session = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/tmp',
        wallClockDeadline: Date.now() + 20,
        abortSignal: ac.signal,
        taskId: 'T',
        taskIndex: 0,
      } as never,
    });

    const turn = session.send('hang please');
    await tick(40);           // the deadline elapses and closes the query
    expect(held.closes).toBeGreaterThan(0);
    ac.abort();               // ...and the caller cancels before the stream has finished
    await tick(5);
    releaseHeldTurn();        // now let the turn end, with BOTH guards having fired

    const result = await turn;

    // The caller asked to stop; the deadline is incidental to what they need to know.
    expect(result.terminationReason).toBe('aborted');
    expect(result.errorCode).toBe('aborted');
  });

  it('reports the deadline when only the deadline fired', async () => {
    resetHeldTurn();
    const session = new ClaudeSession({
      model: 'm',
      opts: {
        cwd: '/tmp',
        wallClockDeadline: Date.now() + 20,
        abortSignal: new AbortController().signal,
        taskId: 'T',
        taskIndex: 0,
      } as never,
    });

    const turn = session.send('hang please');
    await tick(40);
    releaseHeldTurn();

    const result = await turn;
    expect(result.terminationReason).toBe('time_exceeded');
    expect(result.errorCode).toBe('wall_clock_exceeded');
  });
});
