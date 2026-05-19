// Pure completion-judgment function. Single source of truth for determining
// when a task has reached a terminal completion state. Used by:
//   - annotator gate (lifecycle/annotate-parser.ts)
//   - envelope seal (lifecycle/handlers/terminal-handlers.ts)
//
// Inputs are objective lifecycle signals — NOT worker self-assessment.
// Worker self-assessment is logged in telemetry separately, never gates
// completion.

import type { RouteName } from '../lifecycle/stage-io.js';

const READ_ROUTES: ReadonlySet<RouteName> = new Set([
  'audit', 'review', 'debug', 'investigate', 'explore', 'research',
] as RouteName[]);

export interface CompletionInputs {
  route: RouteName;
  implementOutcome: 'advance' | 'skip' | 'halt' | undefined;
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  reviewVerdict: 'approved' | 'concerns' | 'changes_required' | 'annotated' | 'error' | 'skipped' | undefined;
  reviewSubResults?: Array<{ name: 'spec' | 'quality'; verdict: string }>;
  reworkApplied: boolean | undefined;
  reworkError: string | undefined;
  unaddressedFindingIds: string[] | undefined;
  commitKind: 'committed' | 'no_op' | undefined;
  autoCommit: boolean;
  criteriaSucceeded: string[] | undefined;
}

export interface CompletionResult {
  completed: boolean;
  reasons: string[];
}

export function deriveCompletion(inputs: CompletionInputs): CompletionResult {
  const reasons: string[] = [];

  // 1. Implementer must have advanced
  const implementOk = inputs.implementOutcome === 'advance';
  if (!implementOk) reasons.push('implement did not advance');

  // 2. Route-specific completion
  if (READ_ROUTES.has(inputs.route)) {
    const criteriaOk = (inputs.criteriaSucceeded ?? []).length > 0;
    if (!criteriaOk) reasons.push('no successful criteria');
    return { completed: implementOk && criteriaOk, reasons };
  }

  // 3. Write routes: review + commit must pass
  const reviewOk =
    inputs.reviewPolicy === 'none' ||
    inputs.reviewVerdict === 'approved' ||
    (inputs.reviewVerdict === 'changes_required' &&
      inputs.reworkApplied === true &&
      inputs.reworkError === undefined &&
      (inputs.unaddressedFindingIds ?? []).length === 0);
  if (!reviewOk) reasons.push('review did not pass');

  const commitOk =
    inputs.commitKind === 'committed' ||
    inputs.commitKind === 'no_op' ||
    inputs.autoCommit === false;
  if (!commitOk) reasons.push('commit did not complete');

  return { completed: implementOk && reviewOk && commitOk, reasons };
}

// Helper to extract CompletionInputs from LifecycleState.
// Kept here (not in annotate-parser.ts) so the recovery script can
// also use the same extraction logic when reconstructing state from
// persisted wire-record stages JSONB.
import type { LifecycleState } from './stage-plan-types.js';

export function extractCompletionInputs(state: LifecycleState): CompletionInputs {
  const last = state.lastRunResult as { criteriaSucceeded?: string[]; unaddressedFindingIds?: string[] } | undefined;
  // commitKind sources, in priority order:
  //   1. gates.commit.payload.kind — populated by the commit handler (committed / no_op)
  //   2. gates.commit.outcome === 'skip' — populated by the lifecycle driver
  //      when shouldRun returned false (e.g., "no files changed"). That is a
  //      legitimate no-op for completion purposes.
  const commitGate = state.gates?.commit as { outcome?: string; payload?: { kind?: 'committed' | 'no_op' } } | undefined;
  let commitKind: 'committed' | 'no_op' | undefined = commitGate?.payload?.kind;
  if (commitKind === undefined && commitGate?.outcome === 'skip') {
    commitKind = 'no_op';
  }
  return {
    route: state.route as RouteName,
    implementOutcome: state.gates?.implement?.outcome,
    reviewPolicy: state.reviewPolicy,
    reviewVerdict: state.reviewVerdict,
    reviewSubResults: (state as { reviewSubResults?: Array<{ name: 'spec' | 'quality'; verdict: string }> }).reviewSubResults,
    reworkApplied: state.reworkApplied,
    reworkError: state.reworkError,
    unaddressedFindingIds: (state as { unaddressedFindingIds?: string[] }).unaddressedFindingIds ?? last?.unaddressedFindingIds,
    commitKind,
    autoCommit: state.autoCommit ?? true,
    criteriaSucceeded: last?.criteriaSucceeded,
  };
}
