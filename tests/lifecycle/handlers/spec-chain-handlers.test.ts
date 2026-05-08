import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  specReviewRound1Handler,
  specReviewRound2Handler,
  specReviewRound3Handler,
  specReworkRound1Handler,
  settleSpecChainHandler,
} from '../../../packages/core/src/lifecycle/handlers/spec-chain-handlers.js';
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

describe('spec-chain handlers — idempotency', () => {
  it('round_1 skips when verdict slot already populated', async () => {
    const state = makeState({ specReviewRound1Verdict: 'approved' });
    await specReviewRound1Handler(state);
    expect(state.specReviewRound1Verdict).toBe('approved');
  });

  it('round_2 skips when verdict slot already populated', async () => {
    const state = makeState({ specReviewRound2Verdict: 'changes_required' });
    await specReviewRound2Handler(state);
    expect(state.specReviewRound2Verdict).toBe('changes_required');
  });

  it('round_3 skips when verdict slot already populated', async () => {
    const state = makeState({ specReviewRound3Verdict: 'error' });
    await specReviewRound3Handler(state);
    expect(state.specReviewRound3Verdict).toBe('error');
  });
});

describe('spec-chain handlers — defensive no-ops', () => {
  it('round_1 no-ops when executionContext is missing', async () => {
    const state = makeState();
    await specReviewRound1Handler(state);
    expect(state.specReviewRound1Verdict).toBeUndefined();
  });

  it('round_1 no-ops when lastRunResult is missing', async () => {
    const state = makeState({ executionContext: makeCtx() });
    await specReviewRound1Handler(state);
    expect(state.specReviewRound1Verdict).toBeUndefined();
  });

  it('round_1 no-ops when reviewer provider for tier is missing', async () => {
    const ctx = makeCtx({ providers: {} });
    const state = makeState({
      task: { prompt: 'x' } as TaskSpec,
      executionContext: ctx,
      lastRunResult: {
        output: '## Summary\napproved',
        implementationReport: { summary: 'done', filesChanged: [], validationsRun: [], deviationsFromBrief: [], unresolved: [], commit: undefined },
        toolCalls: [],
      } as unknown as LifecycleState['lastRunResult'],
    });
    await specReviewRound1Handler(state);
    expect(state.specReviewRound1Verdict).toBeUndefined();
  });

  it('rework_1 no-ops when executionContext missing', async () => {
    const state = makeState();
    await specReworkRound1Handler(state);
    expect(state.lastRunResult).toBeUndefined();
  });

  it('rework_1 no-ops when impl provider missing', async () => {
    const ctx = makeCtx({ providers: {} });
    const state = makeState({ task: { prompt: 'x' } as TaskSpec, executionContext: ctx });
    await specReworkRound1Handler(state);
    expect(state.lastRunResult).toBeUndefined();
  });

  it('rework_1 marks chain failed when impl call returns no usable result', async () => {
    // When both tiers are unavailable (no providers configured at all),
    // runWithFallback bails with bothUnavailable=true and runSpecRework
    // returns null. The handler must NOT silently fall through — it must
    // set state.specReworkFailed and state.terminal so the next review
    // round's `!s.terminal` gate stops the chain instead of re-reviewing
    // the unchanged code.
    const ctx = makeCtx({ providers: {} });
    const state = makeState({ task: { prompt: 'x' } as TaskSpec, executionContext: ctx });
    await specReworkRound1Handler(state);
    expect(state.specReworkFailed).toBe(true);
    expect(state.terminal).toBe(true);
    expect(state.lastRunResult).toBeUndefined();
  });
});

describe('settleSpecChainHandler', () => {
  it('skips when specChainPassed is already set (idempotency)', () => {
    const state = makeState({ specChainPassed: true });
    settleSpecChainHandler(state);
    expect(state.specChainPassed).toBe(true);
  });

  it('no-ops when no round verdicts populated', () => {
    const state = makeState();
    settleSpecChainHandler(state);
    expect(state.specChainPassed).toBeUndefined();
  });

  it('passes when any round approved', () => {
    const state = makeState({ specReviewRound1Verdict: 'changes_required', specReviewRound2Verdict: 'approved' });
    settleSpecChainHandler(state);
    expect(state.specChainPassed).toBe(true);
    expect(state.terminal).toBe(false);
  });

  it('fails (false, not terminal) when all rounds changes_required', () => {
    const state = makeState({
      specReviewRound1Verdict: 'changes_required',
      specReviewRound2Verdict: 'changes_required',
      specReviewRound3Verdict: 'changes_required',
    });
    settleSpecChainHandler(state);
    expect(state.specChainPassed).toBe(false);
    expect(state.terminal).toBe(false);
  });

  it('hard-fails (terminal) when any round is error', () => {
    const state = makeState({ specReviewRound1Verdict: 'error' });
    settleSpecChainHandler(state);
    expect(state.specChainPassed).toBe(false);
    expect(state.terminal).toBe(true);
  });
});
