// Regression — 4.7.3.
//
// Before this fix, runStagePlan stored the review stage's gate at
// state.gates['review'] but never promoted gate.payload.verdict /
// gate.payload.findings into the top-level state.reviewVerdict /
// state.reviewFindings slots that rework-stage gates on. Result: rework
// always skipped with "rework skipped: review verdict is not
// changes_required" even when the reviewer returned changes_required
// with real findings. The dead-code path entered when the legacy
// reviewed-lifecycle was decommissioned — the old path wrote those
// state fields explicitly; the v5 STAGE_PLAN driver didn't.
//
// This test asserts the driver now hoists payload → state so the
// downstream rework gate can fire.
import { describe, it, expect } from 'vitest';
import { runStagePlan } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { StageDefinition, StageGate } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function approvingReview(): StageDefinition<unknown> {
  return {
    name: 'review',
    runOnHalt: false,
    applicableRoutes: 'all',
    shouldRun: () => ({ run: true }),
    handler: async () => ({
      outcome: 'advance',
      payload: {
        verdict: 'approved',
        findings: [],
        reviewersSucceeded: ['spec', 'quality'],
        reviewersErrored: [],
      },
      telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    }) as StageGate<unknown>,
  };
}

function changesRequiredReview(): StageDefinition<unknown> {
  return {
    name: 'review',
    runOnHalt: false,
    applicableRoutes: 'all',
    shouldRun: () => ({ run: true }),
    handler: async () => ({
      outcome: 'advance',
      payload: {
        verdict: 'changes_required',
        findings: [
          {
            id: 'F1',
            severity: 'high',
            category: 'correctness',
            claim: 'function leaks file handle on early return',
            evidence: 'src/lib/foo.ts:42 — fs.openSync without close in error branch',
            suggestion: 'wrap in try/finally',
            source: 'reviewer',
          },
        ],
        reviewersSucceeded: ['quality'],
        reviewersErrored: [],
      },
      telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    }) as StageGate<unknown>,
  };
}

function noopReview(): StageDefinition<unknown> {
  // Outcome 'skip' — driver must NOT hoist when the stage didn't advance.
  return {
    name: 'review',
    runOnHalt: false,
    applicableRoutes: 'all',
    shouldRun: () => ({ run: true }),
    handler: async () => ({
      outcome: 'skip',
      comment: 'review skipped: policy=none',
      payload: null,
      telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    }) as StageGate<unknown>,
  };
}

function emptyState(): LifecycleState {
  return {
    route: 'delegate',
    executionContext: { heartbeat: { transition: () => { /* no-op */ } } },
    gates: {},
    halted: false,
  } as LifecycleState;
}

describe('lifecycle driver — review payload hoist (4.7.3 regression)', () => {
  it('promotes verdict + findings to state when review advances with changes_required', async () => {
    const state = emptyState();
    await runStagePlan([changesRequiredReview()], state);

    expect((state as { reviewVerdict?: string }).reviewVerdict).toBe('changes_required');
    const findings = (state as { reviewFindings?: Array<{ source: string; text: string }> }).reviewFindings;
    expect(findings).toBeDefined();
    expect(findings).toHaveLength(1);
    expect(findings![0].source).toBe('reviewer');
    expect(findings![0].text).toContain('leaks file handle');
    expect(findings![0].text).toContain('evidence:');
    expect(findings![0].text).toContain('fix:');
  });

  it('promotes verdict=approved with empty findings array', async () => {
    const state = emptyState();
    await runStagePlan([approvingReview()], state);

    expect((state as { reviewVerdict?: string }).reviewVerdict).toBe('approved');
    expect((state as { reviewFindings?: unknown[] }).reviewFindings).toEqual([]);
  });

  it('does not write state.reviewVerdict when review skips', async () => {
    const state = emptyState();
    await runStagePlan([noopReview()], state);

    expect((state as { reviewVerdict?: string }).reviewVerdict).toBeUndefined();
    expect((state as { reviewFindings?: unknown[] }).reviewFindings).toBeUndefined();
  });
});
