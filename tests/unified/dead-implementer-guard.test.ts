// Dead-implementer guard: a turn with no assistant events and no output text
// must fail the pipeline terminally — never proceed to review, where the
// reviewer would fabricate an answer from an empty draft and the dead tier
// would surface as `done` (the refiner-answer masking bug).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTwoPhasePipeline } from '../../packages/core/src/unified/two-phase-pipeline.js';
import type { Provider, SessionOpts, Session, TurnResult } from '../../packages/core/src/types/run-result.js';

function turn(overrides: Partial<TurnResult>): TurnResult {
  return {
    output: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesWritten: [],
    usedShell: false,
    turns: 0,
    durationMs: 5,
    costUSD: 0,
    terminationReason: 'ok',
    ...overrides,
  };
}

function providerOf(result: TurnResult, onSend?: () => void): Provider {
  return {
    name: 'mock:dead-guard',
    config: { type: 'codex', model: 'mock', baseUrl: 'http://mock.local' } as Provider['config'],
    openSession(_opts: SessionOpts): Session {
      return {
        async send(): Promise<TurnResult> {
          onSend?.();
          return result;
        },
        async close(): Promise<void> { /* no-op */ },
        getSessionId(): string | null { return null; },
      };
    },
  };
}

describe('dead-implementer guard', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'mma-dead-guard-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('fails terminally on a 0-turn empty-output implementer; reviewer never runs', async () => {
    let reviewerInvoked = false;
    const result = await runTwoPhasePipeline({
      type: 'investigate',
      implementerSkill: 'skill',
      reviewerSkill: 'review skill',
      taskPayload: '{"prompt":"q"}',
      implementerProvider: providerOf(turn({})),   // claims ok, produced nothing
      reviewerProvider: providerOf(turn({ output: 'fabricated', turns: 1 }), () => { reviewerInvoked = true; }),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'reviewed',
      cwd,
      sandboxPolicy: 'read-only',
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason?.code).toBe('implementer_no_output');
    expect(result.reviewerTurn).toBeNull();
    expect(result.reviewerOutput).toBeNull();
    expect(reviewerInvoked).toBe(false);
    expect(result.completionPercent).toBe(0);
    // The real (dead) turn is carried as evidence, not replaced by a sentinel.
    expect(result.implementerTurn.turns).toBe(0);
    expect(result.implementerTurn.usage.inputTokens).toBe(0);
  });

  it('carries the provider errorCode when the dead turn has one', async () => {
    const result = await runTwoPhasePipeline({
      type: 'investigate',
      implementerSkill: 'skill',
      reviewerSkill: 'review skill',
      taskPayload: '{"prompt":"q"}',
      implementerProvider: providerOf(turn({ terminationReason: 'error', errorCode: 'sdk_no_result', errorMessage: 'stream ended without a result event' })),
      reviewerProvider: providerOf(turn({ output: 'fabricated', turns: 1 })),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'reviewed',
      cwd,
      sandboxPolicy: 'read-only',
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason?.code).toBe('sdk_no_result');
    expect(result.failureReason?.message).toMatch(/without a result event/);
  });

  it('a real implementer turn still proceeds to review', async () => {
    let reviewerInvoked = false;
    const result = await runTwoPhasePipeline({
      type: 'investigate',
      implementerSkill: 'skill',
      reviewerSkill: 'review skill',
      taskPayload: '{"prompt":"q"}',
      implementerProvider: providerOf(turn({ output: 'a real answer', turns: 1, usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 } })),
      reviewerProvider: providerOf(turn({ output: 'refined answer', turns: 1 }), () => { reviewerInvoked = true; }),
      implementerTier: 'complex',
      reviewerTier: 'standard',
      reviewPolicy: 'reviewed',
      cwd,
      sandboxPolicy: 'read-only',
    });

    expect(result.status).not.toBe('failed');
    expect(reviewerInvoked).toBe(true);
  });
});
