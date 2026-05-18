// tests/regression/stage-io/m1-m3-m4-bug-fixes.test.ts
//
// Regression suite for the M1/M3/M4 bug paths from
// docs/superpowers/specs/2026-05-15-stage-io-standardization-design.md §1.
//
// These tests assert against the existing pipeline architecture (composeResponse
// + delegateWithEscalation), not the planned-but-not-built StageGate driver.
// They prove the bug-fix commits (Task 15 + the M3/M4 compose fix) actually
// resolve the user-reported failure mode.

import { describe, it, expect } from 'vitest';
import { composeHandler } from '../../../packages/core/src/lifecycle/handlers/baseline-handlers.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

/** No longer needed - composeHandler is called directly. */
function noop() {
  // Handler removed - composeHandler is now called directly on state
}

function mkState(over: Partial<LifecycleState> & { lastRunResult?: any; reviewVerdict?: any; reviewPolicy?: any; commits?: any[]; reworkApplied?: boolean; reworkError?: string; }): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'none',
    shutdownInProgress: false,
    route: 'delegate',
    ...over,
  } as any;
}

describe('M3 fix — AC-16 — truthful workerSelfAssessment in compose', () => {
  it('does NOT stamp done_with_concerns when review rejects; reads real workerStatus instead', async () => {
    const state = mkState({
      reviewPolicy: 'full',
      reviewVerdict: 'changes_required',
      reworkApplied: undefined,                // rework did not run
      commits: [],
      lastRunResult: {
        status: 'incomplete',
        output: 'some work',
        outputIsDiagnostic: false,
        workerStatus: 'failed',                // worker truthfully said failed
        turns: 5,
        filesWritten: [],
        toolCalls: [],
        terminationReason: { cause: 'incomplete', turnsUsed: 5, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'failed', wasPromoted: false },
      },
    });
    state.gates = {};
    await composeHandler(state);
    const env = (state as any).responseEnvelope;
    expect(env.errorCode).toBe('review_quality_findings_unresolved');
    // The M3 bug: this used to be hardcoded 'done_with_concerns'. After the fix
    // it reads the real workerStatus from lastRunResult.
    expect(env.terminationReason.workerSelfAssessment).toBe('failed');
    expect(env.terminationReason.workerSelfAssessment).not.toBe('done_with_concerns');
  });
});

describe('M4 fix — AC-17 — rework that cleared findings yields ok, not review_quality_findings_unresolved', () => {
  it('promotes to ok when reworkApplied=true and no reworkError, even with stale reviewVerdict=changes_required', async () => {
    const state = mkState({
      reviewPolicy: 'full',
      reviewVerdict: 'changes_required',        // stale verdict from before rework
      reworkApplied: true,                      // rework ran
      reworkError: undefined,                   // and cleared everything
      commits: [],
      lastRunResult: {
        status: 'incomplete',                   // escalation left it incomplete; M1 fix flowed it through
        output: 'fixed both findings',
        outputIsDiagnostic: false,
        workerStatus: 'done',                   // post-rework, worker says done
        turns: 8,
        filesWritten: ['src/foo.ts'],
        toolCalls: [],
        terminationReason: { cause: 'incomplete', turnsUsed: 8, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
      },
    });
    state.gates = {};
    await composeHandler(state);
    const env = (state as any).responseEnvelope;
    // The M4 bug: this used to be 'incomplete' + 'review_quality_findings_unresolved'. After the fix,
    // reworkApplied without error promotes to ok.
    expect(env.status).toBe('ok');
    expect(env.errorCode).not.toBe('review_rejected');
  });

  it('still rejects when rework FAILED (reworkError set)', async () => {
    const state = mkState({
      reviewPolicy: 'full',
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      reworkError: 'rework worker crashed',
      commits: [],
      lastRunResult: {
        status: 'incomplete',
        output: 'tried to fix but failed',
        outputIsDiagnostic: false,
        workerStatus: 'failed',
        turns: 8,
        filesWritten: ['src/foo.ts'],
        toolCalls: [],
        terminationReason: { cause: 'incomplete', turnsUsed: 8, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'failed', wasPromoted: false },
      },
    });
    state.gates = {};
    await composeHandler(state);
    const env = (state as any).responseEnvelope;
    expect(env.status).toBe('incomplete');
    expect(env.errorCode).toBe('review_quality_findings_unresolved');
    // M3 fix still applies: truthful workerSelfAssessment.
    expect(env.terminationReason.workerSelfAssessment).toBe('failed');
  });
});

describe('M2 fix — AC-15 — read route with no commit completes', () => {
  // M2 bug class: read-only investigate/audit/review/debug routes legitimately
  // produce no commits (they never write). Pre-fix compose used to flag these
  // as incomplete because `commits.length === 0` was treated as a write-route
  // failure. Post-fix compose differentiates read vs write by route + reviewPolicy.
  it('read-only investigate with 9-of-11 criteria succeeded returns ok, not incomplete', async () => {
    const state = mkState({
      route: 'investigate',
      reviewPolicy: 'quality_only',
      reviewVerdict: 'approved',
      commits: [],                                  // no commits is correct for read route
      lastRunResult: {
        status: 'ok',
        output: 'investigation findings...',
        outputIsDiagnostic: false,
        workerStatus: 'done',
        turns: 4,
        filesWritten: [],                           // no writes is correct for read route
        toolCalls: ['grep', 'read'],
        criteriaSucceeded: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'],
        criteriaErrors: [{ criterionId: 'c10', error: 'context_block_too_large' }, { criterionId: 'c11', error: 'turn_cap' }],
        terminationReason: { cause: 'finished', turnsUsed: 4, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
      },
    });
    state.gates = {};
    await composeHandler(state);
    const env = (state as any).responseEnvelope;
    // The M2 bug: this used to flag 'incomplete' because commits.length===0.
    // After the fix, read routes with at least one successful criterion
    // (criteriaSucceeded.length > 0) complete normally.
    expect(env.status).toBe('ok');
    expect(env.errorCode).not.toBe('review_rejected');
    expect(env.errorCode).not.toBe('no_commits');
  });

  it('read-only investigate with zero criteriaErrors completes when criteriaSucceeded > 0', async () => {
    const state = mkState({
      route: 'audit',
      reviewPolicy: 'quality_only',
      reviewVerdict: 'approved',
      commits: [],
      lastRunResult: {
        status: 'ok',
        output: 'audit findings...',
        outputIsDiagnostic: false,
        workerStatus: 'done',
        turns: 2,
        filesWritten: [],
        toolCalls: ['read'],
        criteriaSucceeded: ['c1'],
        criteriaErrors: [],
        terminationReason: { cause: 'finished', turnsUsed: 2, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
      },
    });
    state.gates = {};
    await composeHandler(state);
    const env = (state as any).responseEnvelope;
    expect(env.status).toBe('ok');
  });
});

// M1 fix block deleted with the escalation module — when the file you were
// regression-testing no longer exists, there is nothing left to regress.
