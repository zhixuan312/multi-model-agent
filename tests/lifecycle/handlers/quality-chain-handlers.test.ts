import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  qualityReviewRound1Handler,
  qualityReviewRound2Handler,
  qualityReviewRound3Handler,
  qualityReworkRound1Handler,
  settleQualityChainHandler,
} from '../../../packages/core/src/lifecycle/handlers/quality-chain-handlers.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { TaskSpec } from '../../../packages/core/src/types.js';

function makeState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const base = {
    task: { prompt: 'x', tools: 'full', timeoutMs: 60_000 } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd: os.tmpdir(),
    route: 'delegate',
    client: 'test',
    mainModel: null,
    assignedTier: 'standard' as const,
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full' as const,
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
  };
  return { ...base, ...overrides };
}

describe('quality-chain handlers — idempotency', () => {
  it('round_1 skips when verdict slot already populated', async () => {
    const state = makeState({ qualityReviewRound1Verdict: 'approved' });
    await qualityReviewRound1Handler(state);
    expect(state.qualityReviewRound1Verdict).toBe('approved');
  });

  it('round_2 skips when verdict slot already populated', async () => {
    const state = makeState({ qualityReviewRound2Verdict: 'changes_required' });
    await qualityReviewRound2Handler(state);
    expect(state.qualityReviewRound2Verdict).toBe('changes_required');
  });

  it('round_3 skips when verdict slot already populated', async () => {
    const state = makeState({ qualityReviewRound3Verdict: 'annotated' });
    await qualityReviewRound3Handler(state);
    expect(state.qualityReviewRound3Verdict).toBe('annotated');
  });
});

describe('quality-chain handlers — defensive no-ops', () => {
  it('round_1 no-ops when executionContext missing', async () => {
    const state = makeState();
    await qualityReviewRound1Handler(state);
    expect(state.qualityReviewRound1Verdict).toBeUndefined();
  });

  it('round_1 no-ops when lastRunResult missing', async () => {
    const state = makeState({ executionContext: makeCtx() });
    await qualityReviewRound1Handler(state);
    expect(state.qualityReviewRound1Verdict).toBeUndefined();
  });

  it('rework_1 no-ops when executionContext missing', async () => {
    const state = makeState();
    await qualityReworkRound1Handler(state);
    expect(state.lastRunResult).toBeUndefined();
  });

  it('rework_1 no-ops when impl provider missing for tier 1 row', async () => {
    const ctx = makeCtx({ providers: {} });
    const state = makeState({ task: { prompt: 'x' } as TaskSpec, executionContext: ctx });
    await qualityReworkRound1Handler(state);
    expect(state.lastRunResult).toBeUndefined();
  });

  it('rework_1 marks chain failed when impl call returns no usable result', async () => {
    // Symmetric with spec-chain: when the rework's implementer call doesn't
    // produce an ok RunResult, the handler must set qualityReworkFailed +
    // terminal so the next review round's `!s.terminal` gate halts the
    // cascade. Without this the chain re-reviews unchanged code three times.
    const ctx = makeCtx({ providers: {} });
    const state = makeState({ task: { prompt: 'x' } as TaskSpec, executionContext: ctx });
    await qualityReworkRound1Handler(state);
    expect(state.qualityReworkFailed).toBe(true);
    expect(state.terminal).toBe(true);
    expect(state.lastRunResult).toBeUndefined();
  });
});

describe('settleQualityChainHandler', () => {
  it('skips when qualityChainPassed already set (idempotency)', () => {
    const state = makeState({ qualityChainPassed: true });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(true);
  });

  it('no-ops when no round verdicts populated', () => {
    const state = makeState();
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBeUndefined();
  });

  it('passes when any round approved', () => {
    const state = makeState({
      qualityReviewRound1Verdict: 'changes_required',
      qualityReviewRound2Verdict: 'approved',
    });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(true);
  });

  it("passes when any round 'annotated' (read-only route path)", () => {
    const state = makeState({ qualityReviewRound1Verdict: 'annotated' });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(true);
  });

  it("passes when round is 'skipped' (no files written)", () => {
    const state = makeState({ qualityReviewRound1Verdict: 'skipped' });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(true);
  });

  it('fails (false, not terminal) when all rounds changes_required', () => {
    const state = makeState({
      qualityReviewRound1Verdict: 'changes_required',
      qualityReviewRound2Verdict: 'changes_required',
      qualityReviewRound3Verdict: 'changes_required',
    });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(false);
    expect(state.terminal).toBe(false);
  });

  it('hard-fails (terminal) when any round is error', () => {
    const state = makeState({ qualityReviewRound2Verdict: 'error' });
    settleQualityChainHandler(state);
    expect(state.qualityChainPassed).toBe(false);
    expect(state.terminal).toBe(true);
  });
});
