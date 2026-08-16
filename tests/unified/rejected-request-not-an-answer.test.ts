import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTwoPhasePipeline } from '../../packages/core/src/unified/two-phase-pipeline.js';

vi.mock('../../packages/core/src/unified/repo-commit.js', () => ({
  captureBaseline: vi.fn().mockResolvedValue({ head: 'base0', branch: 'mma/x', dirtyAtDispatch: false }),
  assertRepoUntampered: vi.fn().mockResolvedValue(undefined),
  commitAll: vi.fn().mockResolvedValue({ committed: true, head: 'new1', filesChanged: [] }),
}));

// When a provider rejects a request outright — the assembled prompt exceeds the
// model's input limit, the credential is refused, the model name is unknown —
// it bills nothing and generates nothing. Some runners hand that rejection back
// as the turn's TEXT rather than as empty output.
//
// The danger is not the failure; it is the shape of the failure. A turn with
// non-empty text walks past an emptiness check, gets reviewed, and the task
// reports `done` with the provider's error string sitting in the answer field.
// A caller reading only `output.summary` cannot tell that apart from a real
// answer.
//
// Zero total token usage is what separates a rejection from a ceiling like
// max-turns or max-budget, where the model did real work first and the partial
// output is genuinely worth reviewing.

const usage = (total: number) => ({
  inputTokens: total,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedNonReadTokens: 0,
});

const turn = (over: Partial<Record<string, unknown>>) => ({
  output: '',
  usage: usage(0),
  costUSD: 0,
  turns: 1,
  durationMs: 1200,
  terminationReason: 'ok' as const,
  filesWritten: [],
  usedShell: false,
  toolCalls: [],
  ...over,
});

const session = (result: ReturnType<typeof turn>) => ({
  send: vi.fn().mockResolvedValue(result),
  close: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue('sess-mock'),
});

const provider = (s: ReturnType<typeof session>) => ({
  name: 'mock',
  config: {},
  openSession: vi.fn().mockReturnValue(s),
});

const run = (implTurn: ReturnType<typeof turn>, reviewer = session(turn({ output: '{"status":"done","notes":"ok"}' }))) =>
  runTwoPhasePipeline({
    type: 'journal_recall',
    readerFacing: true,
    implementerSkill: '# Implement',
    reviewerSkill: '# Review',
    taskPayload: 'what did we learn',
    implementerProvider: provider(session(implTurn)),
    reviewerProvider: provider(reviewer),
    implementerTier: 'complex',
    reviewerTier: 'complex',
    reviewPolicy: 'reviewed',
    cwd: '/tmp/test',
    sandboxPolicy: 'read-only',
  });

describe('a rejected request is a failure, not an answer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails terminally when the provider rejected the request and billed nothing', async () => {
    const reviewer = session(turn({ output: '{"status":"done","notes":"ok"}' }));
    const result = await run(
      turn({
        output: 'Prompt is too long: 412000 tokens > 200000 maximum',
        terminationReason: 'error',
        errorCode: 'sdk_execution_error',
        errorMessage: 'Prompt is too long: 412000 tokens > 200000 maximum',
        usage: usage(0),
      }),
      reviewer,
    );

    expect(result.status).toBe('failed');
    // The reviewer must never run on a rejection: refining a provider error
    // into well-formed prose is how the error reaches the caller as an answer.
    expect(reviewer.send).not.toHaveBeenCalled();
    expect(result.failureReason?.message).toContain('Prompt is too long');
  });

  it('still fails when the runner leaves the output empty', async () => {
    const result = await run(
      turn({
        output: '',
        turns: 0,
        terminationReason: 'error',
        errorCode: 'sdk_execution_error',
        usage: usage(0),
      }),
    );
    expect(result.status).toBe('failed');
  });

  it('does NOT fail a ceiling that produced real work', async () => {
    // max-turns burns tokens and leaves partial output. That output is worth
    // reviewing, and treating it as a rejection would throw away real work.
    const result = await run(
      turn({
        output: '{"status":"done","notes":"partial but real"}',
        terminationReason: 'error',
        errorCode: 'sdk_max_turns',
        usage: usage(18_000),
      }),
    );
    expect(result.status).not.toBe('failed');
  });

  it('does not misfire on a normal turn that used no cached tokens', async () => {
    // `usage(500)` has zero cached counters. The rejection arm keys on TOTAL
    // usage being zero, so a turn billing only uncached input must be
    // unaffected. Asserting "not failed" rather than "done" keeps this test
    // about the rejection arm — the reviewer's own verdict is another test's
    // subject.
    const result = await run(turn({ output: '{"status":"done","notes":"fine"}', usage: usage(500) }));
    expect(result.status).not.toBe('failed');
  });
});
