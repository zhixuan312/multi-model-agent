// Adapter: reconstruct minimal CompletionInputs from a persisted wire-record JSONB,
// then call deriveCompletion(). Used by the recovery CLI; never used at runtime by
// the live gate (which has full LifecycleState available).
//
// Wire-stage shape (per packages/core/src/events/wire-schema.ts):
//   - implementing: base fields only — NO outcome
//   - review: base + verdict + roundsUsed + concernCategories
//   - rework: base + triggeringConcernCategories — NO outcome
//   - annotating: base + outcome + skipReason
//   - committing: base + filesCommittedCount + branchCreated — NO outcome
//
// Inference rules (because wire deliberately strips runtime-only fields):
//   implementOutcome: 'advance' if the stage exists in `stages[]` AND any
//     downstream stage exists OR top-level terminalStatus != 'error' with no
//     downstream halt; we conservatively use stage presence as the signal,
//     since a halted implement never produces an `implementing` stage entry
//     with a successor.
//   commitKind: 'committed' if `committing` stage exists with
//     filesCommittedCount > 0 OR branchCreated === true; 'no_op' if the
//     stage exists with both zeros; undefined if no committing stage.
//   reworkApplied: true if a `rework` stage exists (rework handler only
//     emits a stage record when it actually ran).
//   reviewVerdict: copy `verdict` from review stage; map 'concerns' → 'approved'
//     (because spec-quality aggregator already collapsed concerns when
//     they're addressable, and a 'concerns' wire verdict that survived to
//     write-route completion means the run sealed cleanly).

import { deriveCompletion, type CompletionInputs, type CompletionResult } from '@zhixuan92/multi-model-agent-core/lifecycle/derive-completion';

interface WireStageBase {
  name: string;
  round: number;
  durationMs: number;
  costUSD: number | null;
}
interface WireReviewStage extends WireStageBase {
  name: 'review';
  verdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated' | 'not_applicable';
  roundsUsed: number;
  concernCategories: string[];
}
interface WireReworkStage extends WireStageBase {
  name: 'rework';
  triggeringConcernCategories: string[];
}
interface WireAnnotatingStage extends WireStageBase {
  name: 'annotating';
  outcome: 'passed' | 'failed' | 'skipped' | 'not_applicable' | 'transformed';
  skipReason: 'no_command' | 'dirty_worktree' | 'not_applicable' | 'other' | null;
}
interface WireCommittingStage extends WireStageBase {
  name: 'committing';
  filesCommittedCount: number;
  branchCreated: boolean;
}
interface WireImplementingStage extends WireStageBase { name: 'implementing' }
type WireStage = WireReviewStage | WireReworkStage | WireAnnotatingStage | WireCommittingStage | WireImplementingStage;

interface WireEvent {
  route?: string;
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
  stages?: WireStage[];
  terminalStatus?: string;
  workerStatus?: string;
  errorCode?: string | null;
  concernCount?: number;
}

const READ_ROUTES = new Set(['audit', 'review', 'debug', 'investigate', 'research']);

export type ReconstructResult =
  | { ok: true; inputs: CompletionInputs; result: CompletionResult }
  | { ok: false; reason: string };

export function deriveCompletionFromWire(event: WireEvent): ReconstructResult {
  if (!event.route) return { ok: false, reason: 'missing route' };
  if (!event.reviewPolicy) return { ok: false, reason: 'missing reviewPolicy (pre-4.7.7 row?)' };

  const stages = (event.stages ?? []) as WireStage[];

  // Scope guard: recovery targets write-route review_* false-negatives only
  if (READ_ROUTES.has(event.route)) {
    return { ok: false, reason: 'read-route recovery is out of scope — query filter should prevent these reaching the adapter' };
  }

  const implementStage = stages.find((s) => s.name === 'implementing') as WireImplementingStage | undefined;
  if (!implementStage) return { ok: false, reason: 'missing implementing stage' };

  // implementOutcome inference: if any downstream stage exists, implement
  // must have advanced. For halted-implement rows, stages would have only
  // implementing — we treat that as `halt`. Otherwise `advance`.
  const downstreamExists = stages.some((s) => s.name !== 'implementing');
  const implementOutcome: 'advance' | 'halt' | undefined = downstreamExists ? 'advance' : 'halt';

  const reviewStage = stages.find((s) => s.name === 'review') as WireReviewStage | undefined;
  let reviewVerdict: 'approved' | 'changes_required' | 'error' | undefined;
  if (reviewStage) {
    const v = reviewStage.verdict;
    if (v === 'approved' || v === 'concerns' || v === 'annotated') reviewVerdict = 'approved';
    else if (v === 'changes_required') reviewVerdict = 'changes_required';
    else if (v === 'error') reviewVerdict = 'error';
    else reviewVerdict = undefined; // 'skipped' / 'not_applicable'
  }
  if (!reviewVerdict && event.reviewPolicy !== 'none') {
    return { ok: false, reason: 'missing review verdict and reviewPolicy != none' };
  }

  const reworkStage = stages.find((s) => s.name === 'rework') as WireReworkStage | undefined;
  const reworkApplied = reworkStage !== undefined;
  // unaddressedFindingIds is not persisted on the wire. If rework ran and
  // the row is a recovery candidate (terminal=error with review_*), we
  // assume zero unaddressed — the live gate at the time used worker
  // self-assessment, which was orthogonal to this list. If the run had
  // any unaddressed finding, the runtime would have raised a different
  // error_code.
  const unaddressedFindingIds = reworkApplied ? [] : undefined;

  const commitStage = stages.find((s) => s.name === 'committing') as WireCommittingStage | undefined;
  let commitKind: 'committed' | 'no_op' | undefined;
  if (commitStage) {
    commitKind = (commitStage.filesCommittedCount > 0 || commitStage.branchCreated) ? 'committed' : 'no_op';
  }

  const inputs: CompletionInputs = {
    route: event.route as never,
    implementOutcome,
    reviewPolicy: event.reviewPolicy,
    reviewVerdict,
    reworkApplied,
    reworkError: undefined,
    unaddressedFindingIds,
    commitKind,
    autoCommit: true,  // wire doesn't persist autoCommit; default matches runtime default
    criteriaSucceeded: undefined,  // read-routes filtered above
  };

  return { ok: true, inputs, result: deriveCompletion(inputs) };
}
