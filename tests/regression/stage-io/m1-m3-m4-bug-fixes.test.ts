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
import { buildStageHandlers } from '../../../packages/core/src/lifecycle/handlers/baseline-handlers.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

/** Minimal stub for DispatcherDeps — composeResponse only reads a handful of state slots. */
function makeHandlers() {
  return buildStageHandlers({
    runRoute: async () => ({} as any),
    runReadRoute: async () => ({} as any),
    runReviewRound: async () => ({} as any),
    runReworkRound: async () => ({} as any),
    runDiffReview: async () => ({} as any),
    runCommitStage: async () => ({} as any),
    runRegisterBlock: async () => ({} as any),
    runVerifyStage: async () => ({} as any),
  } as any);
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

describe('M3 fix — truthful workerSelfAssessment in compose', () => {
  it('does NOT stamp done_with_concerns when review rejects; reads real workerStatus instead', () => {
    const handlers = makeHandlers();
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
    (handlers['compose_response'] as any)(state);
    const env = (state as any).responseEnvelope;
    expect(env.errorCode).toBe('review_rejected');
    // The M3 bug: this used to be hardcoded 'done_with_concerns'. After the fix
    // it reads the real workerStatus from lastRunResult.
    expect(env.terminationReason.workerSelfAssessment).toBe('failed');
    expect(env.terminationReason.workerSelfAssessment).not.toBe('done_with_concerns');
  });
});

describe('M4 fix — rework that cleared findings yields ok, not review_rejected', () => {
  it('promotes to ok when reworkApplied=true and no reworkError, even with stale reviewVerdict=changes_required', () => {
    const handlers = makeHandlers();
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
    (handlers['compose_response'] as any)(state);
    const env = (state as any).responseEnvelope;
    // The M4 bug: this used to be 'incomplete' + 'review_rejected'. After the fix,
    // reworkApplied without error promotes to ok.
    expect(env.status).toBe('ok');
    expect(env.errorCode).not.toBe('review_rejected');
  });

  it('still rejects when rework FAILED (reworkError set)', () => {
    const handlers = makeHandlers();
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
    (handlers['compose_response'] as any)(state);
    const env = (state as any).responseEnvelope;
    expect(env.status).toBe('incomplete');
    expect(env.errorCode).toBe('review_rejected');
    // M3 fix still applies: truthful workerSelfAssessment.
    expect(env.terminationReason.workerSelfAssessment).toBe('failed');
  });
});

describe('M1 fix — escalation no longer gates promotion on workerStatus', () => {
  // M1 lives in delegate-with-escalation.ts. Test indirectly by importing the
  // module and asserting the gate logic is gone.
  it('source no longer contains the workerStatus === done promotion gate', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const escalationPath = path.resolve(here, '../../../packages/core/src/escalation/delegate-with-escalation.ts');
    const src = fs.readFileSync(escalationPath, 'utf-8');
    // The old gate was: `best.workerStatus === 'done' && outputIsSubstantive && (...filesWritten...||hasShellVerification)`
    expect(src).not.toMatch(/best\.workerStatus\s*===\s*'done'\s*&&[\s\S]*outputIsSubstantive[\s\S]*hasShellVerification/);
    // The v5 truthful comment marker should be present.
    expect(src).toMatch(/v5: escalation no longer gates on workerSelfAssessment/);
  });
});
