import type { ToolCategory } from '../escalation/escalation-policy.js';
import type { ProjectContext } from '../stores/project-context-registry.js';

export interface StageRow {
  rowId: string;
  stageName: string;
  schemaStage?: string;
  runCondition: (state: LifecycleState) => boolean;
  isRework: boolean;
  handlerKey: string;
  /**
   * When true, this row's handler runs even after a prior row set
   * `state.terminal = true`. Used by settle/compose/terminal/persist/flush
   * rows that must populate authoritative chain-pass + envelope state on
   * hard-fail paths. The driver loop honors this attribute; non-terminal-safe
   * rows (the default) short-circuit when `state.terminal` is set.
   */
  runOnTerminal?: boolean;
}

export interface StagePlan {
  toolCategory: ToolCategory;
  rows: StageRow[];
}

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

export interface LifecycleState {
  terminal: boolean;
  workerStatus?: string;
  reviewVerdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  attemptIndex: number;
  attemptBudget: number;
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
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
  // failed before producing an updated RunResult — e.g. the runner aborted
  // at the abortSignal check, the deadline was exhausted, or the provider
  // returned a non-ok status the rework loop couldn't recover). Without
  // these, the chain would silently advance to the next review round on
  // the same code, producing the "3 rounds, 0 reworks" pattern.
  specReworkFailed?: boolean;
  qualityReworkFailed?: boolean;

  // Per-chain attempt counters for telemetry. Populated by review-round
  // handlers when they call pickEscalation. Quality starts at 1 because
  // attemptIndex 0 has impl: null in the quality loop and pickEscalation
  // would throw.
  specChainAttemptIndex?: number;
  qualityChainAttemptIndex?: number;

  // Per-loop sticky unavailable maps (UnavailableMap) — shared by all
  // runWithFallback calls within a chain so a tier marked unavailable in
  // round 1 stays unavailable for round 2/3. Populated by review-round
  // handlers.
  specUnavailable?: import('../escalation/fallback.js').UnavailableMap;
  qualityUnavailable?: import('../escalation/fallback.js').UnavailableMap;
  diffUnavailable?: import('../escalation/fallback.js').UnavailableMap;

  // Dispatcher / executor wiring (populated by prepare_execution_context and
  // run_initial_impl; consumed by compose_response):
  executor?: (rawRequest: unknown, state: LifecycleState) => Promise<unknown>;
  executorResult?: unknown;
  responseEnvelope?: unknown;

  // StagePlan row 5.2 gate inputs (typed; previously read via `(s as any)`):
  autoCommit?: boolean;
  filesChanged?: string[];
  readOnlyTask?: boolean;
  verifyCommandPresent?: boolean;
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
   * Snapshot-based diff tracker. Captured before the implementer runs;
   * used at every reviewer call site to produce a cumulative unified
   * diff (every change since task start) so reviewers can ground their
   * verdicts in evidence rather than the worker's prose claim.
   * Tool sweep #6.
   */
  diffTracker?: import('./diff-tracker.js').DiffTracker;
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

  // Terminal-handler idempotency slots. Each terminal handler skips when
  // its slot is set, so re-runs (e.g. retry) and inter-handler ordering
  // remain idempotent without duplicate work.
  terminalBlockId?: string;
  taskTerminalEmitted?: boolean;
  batchRegistryPersisted?: boolean;
  taskCompletedRecorded?: boolean;
  telemetryFlushed?: boolean;

  // Per-project runtime state — plumbed from DispatchInput.context.projectContext
  // so register_to_block_store and other stage handlers can access the project
  // context without reaching through ExecutionContext.
  projectContext?: ProjectContext;

  // Block registration result set by register_to_block_store stage handler.
  blockRegistration?: { id: string; size: number; ttlMs: number };

  // Slots used by existing pre-#45 handlers (execution-context-builder,
  // task-executor, derive-terminal-status). Typed as `unknown` until the
  // owning step (Step 1 / Step 5 / Step 6) firms them up.
  cwd?: string;
  runInput?: unknown;
  systemPrompt?: string;
  userMessage?: string;
  maxTurns?: number;
  callCache?: unknown;
  taskIndex?: number;
  artifactsCheck?: string;
  verifyOutcome?: string;
  guardFires?: string[];
  terminalStatus?: string;
  terminationReason?: string | null;
}
