import type { ToolCategory } from './tool-category.js';
import type { ProjectContext } from '../stores/project-context-registry.js';

// `StagePlan` / `StageRow` deleted in v5 — the canonical plan is the flat
// `StageDefinition[]` exported as `STAGE_PLAN` from stage-plan-builder.ts.
// Routes drive participation via `applicableRoutes` + `shouldRun` on each
// StageDefinition, not via per-row runCondition predicates on rows.

/**
 * Per-round review verdict shape. Matches the verdict values that
 * spec-reviewer.ts and quality-reviewer.ts actually produce. `'concerns'` was
 * removed in #45 Step 0 — no spec/quality reviewer in this codebase emits it
 * (the diff reviewer's `kind: 'concerns'` is a separate, kind-typed value
 * mapped to envelope `'approved'`; see Behavioral change #1 in the plan).
 */
type SpecRoundVerdict =
  | 'approved'
  | 'changes_required'
  | 'error'
  | 'skipped';

type QualityRoundVerdict =
  | 'approved'
  | 'changes_required'
  | 'annotated'
  | 'error'
  | 'skipped';

type DiffEnvelopeVerdict = 'approved' | 'changes_required' | 'error' | 'skipped';
type DiffReviewKind = 'approve' | 'concerns' | 'reject' | 'transport_failure';

import type { StageGate, ReviewPayload } from './stage-io.js';

export interface LifecycleState {
  terminal: boolean;
  /** v5: per-stage gate record written by the driver. Empty until prepare runs. */
  gates?: Record<string, StageGate<unknown>>;
  /** v5: halted flag set when any stage returns outcome:'halt'. Driver-only. */
  halted?: boolean;
  workerStatus?: string;
  reviewPolicy: 'reviewed' | 'none';
  shutdownInProgress: boolean;
  route?: string;
  toolCategory?: ToolCategory;
  request?: unknown;

  // Per-row verdict slots (cascade semantics — undefined as shorting token):
  specReviewRound1Verdict?: SpecRoundVerdict;
  specReviewRound2Verdict?: SpecRoundVerdict;
  specReviewRound3Verdict?: SpecRoundVerdict;
  qualityReviewRound1Verdict?: QualityRoundVerdict;
  qualityReviewRound2Verdict?: QualityRoundVerdict;
  qualityReviewRound3Verdict?: QualityRoundVerdict;

  // Diff review: store both the raw kind (for telemetry) and the envelope-
  // mapped status (for downstream gates/response). See Step 4 of the plan.
  diffReviewVerdict?: DiffEnvelopeVerdict;
  diffReviewKind?: DiffReviewKind;

  // Chain-pass slots (set by settle_spec_chain / settle_quality_chain;
  // consumed by row 4.11 diff_review and quality_review_round_1 predicates):
  specChainPassed?: boolean;
  qualityChainPassed?: boolean;

  // Set by rework handlers when their implementer call returns null (call
  // failed before producing an updated RuntimeRunResult — e.g. the runner aborted
  // at the abortSignal check, the deadline was exhausted, or the provider
  // returned a non-ok status the rework loop couldn't recover). Without
  // these, the chain would silently advance to the next review round on
  // the same code, producing the "3 rounds, 0 reworks" pattern.
  specReworkFailed?: boolean;
  qualityReworkFailed?: boolean;

  // Per-chain attempt counters for telemetry. Populated by review-round
  // handlers when they call pickEscalation. Quality starts at 1 because
  // the first attempt (index 0) has impl: null in the quality loop and
  // pickEscalation would throw.
  specChainAttemptIndex?: number;
  qualityChainAttemptIndex?: number;

  // (UnavailableMap fields removed — they were declared but no code path
  // reads or writes them; tier-fallback machinery is being deleted along
  // with the escalation/ directory.)

  // Dispatcher / executor wiring (consumed by compose_response):
  executorResult?: unknown;
  responseEnvelope?: unknown;

  // StagePlan row 5.2 gate inputs (typed; previously read via `(s as any)`):
  filesChanged?: string[];
  readOnlyTask?: boolean;
  contextBlockIds?: string[];

  // Slots populated by Step 1+ handlers as the decomposition advances. Listed
  // here so the type narrows over time and silently-misspelled writes are
  // caught at compile. Exact value types are firmed up in the steps that
  // populate them; `unknown` is the placeholder until then.
  task?: unknown;
  executionContext?: import('./lifecycle-context.js').ExecutionContext;
  lastRunResult?: unknown;
  verifyResult?: unknown;
  commits?: unknown;
  /**
   * Concerns flagged by spec_review rounds 1..N. Round N+1's reviewer
   * receives them so it can verify the rework addressed each.
   */
  priorSpecConcerns?: string[];
  /** Same as priorSpecConcerns but for the quality review chain. */
  priorQualityConcerns?: string[];
  commitError?: string;
  stageStats?: unknown;
  terminalRunResult?: unknown;
  currentStage?: string;
  errorCode?: string | null;

  // ── Pipeline-redesign slots (4.3.0+) — review (lint-only) + rework split ───
  /** Spec lint-reviewer raw report text. */
  specReviewerNotes?: string;
  /** Quality lint-reviewer raw report text. */
  qualityReviewerNotes?: string;
  /** Spec reviewer parsed verdict. */
  specReviewVerdict?: 'approved' | 'changes_required';
  /** Quality reviewer parsed verdict. */
  qualityReviewVerdict?: 'approved' | 'changes_required';
  /** Spec lint-reviewer transport/return error (call failed). */
  specReviewError?: string;
  /** Quality lint-reviewer transport/return error. */
  qualityReviewError?: string;
  /** Review-stage overall error (used when neither reviewer returned a usable verdict). */
  reviewError?: string;
  /** Rework stage applied edits (true) or skipped (false). undefined = stage never ran. */
  reworkApplied?: boolean;
  /** Rework worker's raw summary. */
  reworkOutput?: string;
  /** Rework stage error (transport/return). */
  reworkError?: string;

  // Terminal-handler idempotency slots. Each terminal handler skips when
  // its slot is set, so re-runs (e.g. retry) and inter-handler ordering
  // remain idempotent without duplicate work.
  contextBlockId?: string;
  taskTerminalEmitted?: boolean;
  batchRegistryPersisted?: boolean;
  taskCompletedRecorded?: boolean;
  telemetryFlushed?: boolean;

  // Per-project runtime state — plumbed from DispatchInput.context.projectContext
  // so register_to_block_store and other stage handlers can access the project
  // context without reaching through ExecutionContext.
  projectContext?: ProjectContext;

  // Slots used by existing pre-#45 handlers (execution-context-builder,
  // task-executor, derive-terminal-status). Typed as `unknown` until the
  // owning step (Step 1 / Step 5 / Step 6) firms them up.
  cwd?: string;

  // Sub-project A: pre-task git snapshot captured at task-executor entry.
  // Undefined when cwd is not a git work-tree. Both populated together or both undefined.
  preTaskHeadSha?: string;
  preTaskUntrackedFiles?: Set<string>;

  // Goal mode (write routes): HEAD at goal-set start, captured by the prepare
  // stage inside withWriteGoalLock. The report builder reads baseSha..HEAD.
  goalBaseSha?: string;
  /** Phase-2 (review-fix) raw output, for the deterministic goal report. */
  goalPhase2Output?: string;
  /** Phase-2 transport error, if any (run still completes from phase-1 commits). */
  goalPhase2Error?: string;
  /** Commits in baseSha..HEAD, set by the annotate goal-branch; feeds the
   *  terminal seal's completion derivation (failed only on zero commits). */
  goalCommitCount?: number;

  // Sub-project C: progress-watchdog mutations. Set by the watchdog when its
  // signals trip. Read by the next iteration of the turn loop (preStopReason)
  // and by sub-project B's annotator (thrashingDetected, scopeViolations).
  preStopReason?: 'thrashing' | 'cost' | 'stall' | 'cancelled';
  thrashingDetected?: boolean;
  scopeViolations?: string[];

  runInput?: unknown;
  systemPrompt?: string;
  userMessage?: string;
  maxTurns?: number;
  callCache?: unknown;
  taskIndex?: number;
  artifactsCheck?: string;
  guardFires?: string[];
  terminalStatus?: string;
  terminationReason?: string | null;
}

/**
 * Canonical accessor for the review stage's verdict + findings, read straight
 * from `state.gates.review.payload` (the v5 single source of truth). Replaces
 * the old `state.reviewVerdict` / `state.reviewFindings` hoist: it applies the
 * same `Finding[] -> { source, text }` mapping the hoist used, so downstream
 * consumers (rework, annotate, enrich) see an identical shape. When the review
 * gate is absent (review skipped / read route), returns `{ verdict: undefined,
 * findings: [] }` — matching the prior mirror's undefined/empty-array semantics.
 */
export function reviewPayload(state: LifecycleState): {
  verdict: ReviewPayload['verdict'] | undefined;
  findings: Array<{ source: string; text: string }>;
} {
  const p = state.gates?.['review']?.payload as ReviewPayload | null | undefined;
  const verdict =
    p?.verdict === 'approved' || p?.verdict === 'changes_required' ? p.verdict : undefined;
  const findings = Array.isArray(p?.findings)
    ? p!.findings.map((f: { source?: string; claim?: string; evidence?: string; suggestion?: string; text?: string }) => {
        const parts: string[] = [];
        if (f.claim) parts.push(f.claim);
        if (f.evidence) parts.push(`(evidence: ${f.evidence})`);
        if (f.suggestion) parts.push(`(fix: ${f.suggestion})`);
        const text = parts.length > 0 ? parts.join(' ') : (f.text ?? '');
        return { source: f.source ?? 'reviewer', text };
      })
    : [];
  return { verdict, findings };
}
