import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Base schemas
// ---------------------------------------------------------------------------

/** Shared base for task-level events (has taskIndex). */
const TaskBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
  taskIndex: z.number().int().min(0),
});

/** Shared base for batch-level events (no taskIndex). */
const BatchBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Reusable enum / literal helpers
// ---------------------------------------------------------------------------

const RouteEnum = z.enum([
  'delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'retry',
  'explore_internal', 'explore_external', 'explore_synthesize',
  'register-context-block',
]);

const TierEnum = z.enum(['standard', 'complex']);

const DiagLoopEnum = z.enum(['spec', 'quality', 'diff']);

const DiagRoleEnum = z.enum([
  'implementer', 'specReviewer', 'qualityReviewer', 'diffReviewer',
]);

const DiagReasonEnum = z.enum(['transport_failure', 'not_configured', 'reviewer_separation_unsatisfiable']);

const ProviderTypeEnum = z.enum(['claude', 'openai-compatible', 'codex']);

const RunStatusEnum = z.enum([
  'ok', 'incomplete', 'timeout', 'api_aborted', 'api_error',
  'provider_transport_failure', 'error', 'brief_too_vague', 'cost_exceeded', 'unavailable',
]);

const ReviewVerdictEnum = z.enum([
  'approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable',
]);

const VerifyOutcomeEnum = z.enum(['passed', 'failed', 'skipped', 'not_applicable']);

const VerifySkipReasonEnum = z.enum([
  'no_command', 'dirty_worktree', 'not_applicable', 'other',
]);

const WorkerStatusEnum = z.enum([
  'done', 'done_with_concerns', 'needs_context', 'blocked',
  'review_loop_capped', 'failed',
]);

// ---------------------------------------------------------------------------
// Lifecycle events (14)
// ---------------------------------------------------------------------------

export const TaskStartedEvent = TaskBase.extend({
  event: z.literal('task_started'),
  route: RouteEnum,
  cwd: z.string(),
}).strict();

export const StageChangeEvent = TaskBase.extend({
  event: z.literal('stage_change'),
  from: z.string(),
  to: z.string(),
  attempt: z.number().int().min(0).optional(),
  attemptCap: z.number().int().min(0).optional(),
  implTier: TierEnum.optional(),
  reviewerTier: TierEnum.optional(),
  escalated: z.boolean().optional(),
}).strict();

export const HeartbeatEvent = TaskBase.extend({
  event: z.literal('heartbeat'),
  elapsed: z.string(),
  stage: z.string(),
  round: z.number().int().min(0).optional(),
  cap: z.number().int().min(0).optional(),
  tools: z.number().int().min(0),
  read: z.number().int().min(0),
  wrote: z.number().int().min(0),
  text: z.number().int().min(0),
  cost: z.number().min(0).nullable(),
  idle_ms: z.number().int().min(0),
  stage_idle_ms: z.number().int().min(0),
}).strict();

export const FallbackEvent = TaskBase.extend({
  event: z.literal('fallback'),
  loop: DiagLoopEnum,
  attempt: z.number().int().min(0),
  role: DiagRoleEnum,
  assignedTier: TierEnum,
  usedTier: TierEnum,
  reason: DiagReasonEnum,
  triggeringStatus: RunStatusEnum.optional(),
  violatesSeparation: z.boolean(),
  fallbackSeparationRespected: z.boolean().optional(),
  assignedIdentity: z.object({
    providerType: z.string(),
    normalizedEndpoint: z.string(),
    modelId: z.string(),
  }).optional().nullable(),
  usedIdentity: z.object({
    providerType: z.string(),
    normalizedEndpoint: z.string(),
    modelId: z.string(),
  }).optional().nullable(),
}).strict();

export const FallbackUnavailableEvent = TaskBase.extend({
  event: z.literal('fallback_unavailable'),
  loop: DiagLoopEnum,
  attempt: z.number().int().min(0),
  role: DiagRoleEnum,
  assignedTier: TierEnum,
  reason: DiagReasonEnum,
}).strict();

export const EscalationEvent = TaskBase.extend({
  event: z.literal('escalation'),
  loop: DiagLoopEnum,
  attempt: z.number().int().min(0),
  baseTier: TierEnum,
  implTier: TierEnum,
  reviewerTier: TierEnum,
}).strict();

export const EscalationUnavailableEvent = TaskBase.extend({
  event: z.literal('escalation_unavailable'),
  loop: DiagLoopEnum,
  attempt: z.number().int().min(0),
  role: DiagRoleEnum,
  wantedTier: TierEnum,
  reason: DiagReasonEnum,
}).strict();

export const ReviewDecisionEvent = TaskBase.extend({
  event: z.literal('review_decision'),
  stage: DiagLoopEnum,
  verdict: ReviewVerdictEnum,
  round: z.number().int().min(0),
}).strict();

export const VerifyStepEvent = TaskBase.extend({
  event: z.literal('verify_step'),
  command: z.string(),
  status: z.enum(['passed', 'failed', 'error']),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  durationMs: z.number().int().min(0),
  errorMessage: z.string().optional(),
}).strict();

export const VerifySkippedEvent = TaskBase.extend({
  event: z.literal('verify_skipped'),
  reason: VerifySkipReasonEnum,
  stage: z.string(),
}).strict();

export const ReadOnlyReviewQualityEvent = TaskBase.extend({
  event: z.literal('read_only_review.quality'),
  route: z.string(),
  verdict: ReviewVerdictEnum,
  iterationIndex: z.number().int().min(1),
  findingsReviewed: z.number().int().min(0),
  meanConfidence: z.number().min(0).max(100).nullable(),
  durationMs: z.number().int().min(0),
  costUSD: z.number().min(0).nullable(),
}).strict();

export const ReadOnlyReviewTerminalEvent = TaskBase.extend({
  event: z.literal('read_only_review.terminal'),
  route: z.string(),
  roundsUsed: z.number().int().min(0),
  finalQualityVerdict: ReviewVerdictEnum,
  costUSD: z.number().min(0).nullable(),
  durationMs: z.number().int().min(0),
}).strict();

export const StallAbortEvent = TaskBase.extend({
  event: z.literal('stall_abort'),
  idle_ms: z.number().int().min(0),
  threshold_ms: z.number().int().min(0),
}).strict();

export const TimeCheckEvent = TaskBase.extend({
  event: z.literal('time_check'),
  stage: z.string(),
  tripped: z.boolean(),
  wallClockMs: z.number().int().min(0),
  timeoutMs: z.number().int().min(0),
}).strict();

export const CostCheckEvent = TaskBase.extend({
  event: z.literal('cost_check'),
  stage: z.string(),
  tripped: z.boolean(),
  cost_used_usd: z.number().min(0),
  cost_cap_usd: z.number().min(0),
  cost_available: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// Explore-specific events (6) — batch-level, no taskIndex
// ---------------------------------------------------------------------------

export const ExploreParallelStartEvent = BatchBase.extend({
  event: z.literal('explore_parallel_start'),
  internalRoute: z.string(),
  externalRoute: z.string(),
}).strict();

export const ExploreParallelEndEvent = BatchBase.extend({
  event: z.literal('explore_parallel_end'),
  internalOk: z.boolean(),
  externalOk: z.boolean(),
  internalDurationMs: z.number().int().min(0),
  externalDurationMs: z.number().int().min(0),
}).strict();

export const ExploreInternalUnavailableEvent = BatchBase.extend({
  event: z.literal('explore_internal_unavailable'),
  reason: z.string(),
}).strict();

export const ExploreExternalUnavailableEvent = BatchBase.extend({
  event: z.literal('explore_external_unavailable'),
  reason: z.string(),
}).strict();

export const ExploreSynthesizeStartEvent = BatchBase.extend({
  event: z.literal('explore_synthesize_start'),
  internalAvailable: z.boolean(),
  externalAvailable: z.boolean(),
}).strict();

export const ExploreSynthesizeEndEvent = BatchBase.extend({
  event: z.literal('explore_synthesize_end'),
  threadCount: z.number().int().min(0),
  recommendedNextStep: z.boolean(),
  durationMs: z.number().int().min(0),
}).strict();

export const ExploreThreadStartedEvent = BatchBase.extend({
  event: z.literal('explore_thread_started'),
  threadIndex: z.number().int().min(0),
}).strict();

export const ExploreThreadCompletedEvent = BatchBase.extend({
  event: z.literal('explore_thread_completed'),
  threadIndex: z.number().int().min(0),
}).strict();

export const BatchCompletedEvent = BatchBase.extend({
  event: z.literal('batch_completed'),
  tool: z.string(),
  durationMs: z.number().int().min(0),
  taskCount: z.number().int().min(0),
}).strict();

export const BatchFailedEvent = BatchBase.extend({
  event: z.literal('batch_failed'),
  tool: z.string(),
  durationMs: z.number().int().min(0),
  errorCode: z.string(),
  errorMessage: z.string(),
}).strict();

// Per-stage stats embedded in TaskCompletedLocalEvent.stages.
// Mirrors core/src/types.ts RawStageStats variants. Local schema is
// strict; cloud TaskCompletedCloudEvent.stages stays z.record(...) and
// inherits no contract changes this release.
const BaseStageStatsSchema = z.object({
  entered: z.boolean(),
  durationMs: z.number().int().min(0).nullable(),
  costUSD: z.number().min(0).nullable(),
  agentTier: z.enum(['standard', 'complex']).nullable(),
  modelFamily: z.string().nullable(),
  model: z.string().nullable(),
  maxIdleMs: z.number().int().min(0).nullable(),
  totalIdleMs: z.number().int().min(0).nullable(),
  activityEvents: z.number().int().min(0).nullable(),
});

const ReviewVerdictNullable = ReviewVerdictEnum.nullable();
const RoundsUsedNullable = z.number().int().min(0).nullable();
const VerifyOutcomeNullable = VerifyOutcomeEnum.nullable();
const VerifySkipReasonNullable = VerifySkipReasonEnum.nullable();

const ImplementingStageStatsSchema   = BaseStageStatsSchema.extend({ stage: z.literal('implementing') });
const SpecReworkStageStatsSchema     = BaseStageStatsSchema.extend({ stage: z.literal('spec_rework') });
const QualityReworkStageStatsSchema  = BaseStageStatsSchema.extend({ stage: z.literal('quality_rework') });
const CommittingStageStatsSchema     = BaseStageStatsSchema.extend({ stage: z.literal('committing') });
const VerifyingStageStatsSchema      = BaseStageStatsSchema.extend({ stage: z.literal('verifying'), outcome: VerifyOutcomeNullable, skipReason: VerifySkipReasonNullable });
const SpecReviewStageStatsSchema     = BaseStageStatsSchema.extend({ stage: z.literal('spec_review'),    verdict: ReviewVerdictNullable, roundsUsed: RoundsUsedNullable });
const QualityReviewStageStatsSchema  = BaseStageStatsSchema.extend({ stage: z.literal('quality_review'), verdict: ReviewVerdictNullable, roundsUsed: RoundsUsedNullable });
const DiffReviewStageStatsSchema     = BaseStageStatsSchema.extend({ stage: z.literal('diff_review'),    verdict: ReviewVerdictNullable, roundsUsed: RoundsUsedNullable });

export const StageStatsMapSchema = z.object({
  implementing:   ImplementingStageStatsSchema,
  spec_rework:    SpecReworkStageStatsSchema,
  quality_rework: QualityReworkStageStatsSchema,
  committing:     CommittingStageStatsSchema,
  verifying:      VerifyingStageStatsSchema,
  spec_review:    SpecReviewStageStatsSchema,
  quality_review: QualityReviewStageStatsSchema,
  diff_review:    DiffReviewStageStatsSchema,
});

export const TaskCompletedLocalEvent = TaskBase.extend({
  event: z.literal('task_completed'),
  status: z.string(),
  workerStatus: z.string().nullable(),
  turns: z.number().int().min(0),
  durationMs: z.number().int().min(0).nullable(),
  filesRead: z.number().int().min(0),
  filesWritten: z.number().int().min(0),
  toolCalls: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedReadTokens: z.number().int().min(0),
  cachedNonReadTokens: z.number().int().min(0),
  costUSD: z.number().min(0).nullable(),
  // New in v3.9.0
  taskMaxIdleMs: z.number().int().min(0).nullable(),
  stallTriggered: z.boolean(),
  stages: z.string(),  // JSON-stringified StageStatsMap; parse with StageStatsMapSchema
}).passthrough();

// ---------------------------------------------------------------------------
// Runner-internal events (5)
// ---------------------------------------------------------------------------

export const WorkerStartEvent = TaskBase.extend({
  event: z.literal('worker_start'),
  model: z.string(),
  providerType: ProviderTypeEnum,
  tier: TierEnum,
}).strict();

export const TurnStartEvent = TaskBase.extend({
  event: z.literal('turn_start'),
  turnIndex: z.number().int().min(0),
  providerType: ProviderTypeEnum,
  model: z.string(),
}).strict();

export const TurnCompleteEvent = TaskBase.extend({
  event: z.literal('turn_complete'),
  turnIndex: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedReadTokens: z.number().int().min(0),
  cachedNonReadTokens: z.number().int().min(0),
  costUSD: z.number().min(0),
  durationMs: z.number().int().min(0),
  providerType: ProviderTypeEnum,
  model: z.string(),
}).strict();

export const ToolCallEvent = TaskBase.extend({
  event: z.literal('tool_call'),
  tool: z.string(),
  turnIndex: z.number().int().min(0),
}).strict();

export const TextEmissionEvent = TaskBase.extend({
  event: z.literal('text_emission'),
  chars: z.number().int().min(0),
  turnIndex: z.number().int().min(0),
}).strict();

// ---------------------------------------------------------------------------
// Cloud-bound events (4)
//
// Mirror the existing telemetry/types.ts schemas but use `event` as the
// discriminator so they fit into the discriminated union. The TelemetrySink
// filters these by event name; fields match the v1 upload shapes.
// Task 6 extends task.completed with 11 new v2 fields.
// ---------------------------------------------------------------------------

export const TaskCompletedCloudEvent = z.object({
  event: z.literal('task.completed'),
  ts: z.string().datetime({ offset: true }),
  // v1 core fields (mirror telemetry/types.ts TaskCompletedEvent)
  route: RouteEnum,
  agentType: TierEnum,
  capabilities: z.array(z.enum(['web_search', 'web_fetch', 'other'])).max(3),
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  triggeredFromSkill: z.string(),
  client: z.string(),
  fileCountBucket: z.enum(['0', '1-5', '6-20', '21-50', '51+']),
  durationBucket: z.enum(['<10s', '10s-1m', '1m-5m', '5m-30m', '30m+']),
  costBucket: z.enum(['$0', '<$0.01', '$0.01-$0.10', '$0.10-$1', '$1+']),
  savedCostBucket: z.enum(['$0', '<$0.10', '$0.10-$1', '$1+', 'unknown']),
  implementerModelFamily: z.string(),
  implementerModel: z.string(),
  terminalStatus: z.enum([
    'ok', 'incomplete', 'timeout', 'error', 'cost_exceeded',
    'brief_too_vague', 'unavailable',
  ]),
  workerStatus: WorkerStatusEnum,
  errorCode: z.string().nullable(),
  escalated: z.boolean(),
  fallbackTriggered: z.boolean(),
  topToolNames: z.array(z.string()).max(20),
  stages: z.record(z.string(), z.unknown()),
}).passthrough();

export const SessionStartedCloudEvent = z.object({
  event: z.literal('session.started'),
  ts: z.string().datetime({ offset: true }),
  configFlavor: z.record(z.string(), z.unknown()),
  providersConfigured: z.array(z.enum(['claude', 'openai-compatible', 'codex'])).max(3),
}).passthrough();

export const InstallChangedCloudEvent = z.object({
  event: z.literal('install.changed'),
  ts: z.string().datetime({ offset: true }),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  trigger: z.enum(['fresh_install', 'upgrade', 'downgrade']),
}).passthrough();

export const SkillInstalledCloudEvent = z.object({
  event: z.literal('skill.installed'),
  ts: z.string().datetime({ offset: true }),
  skill: z.string(),
  client: z.string(),
}).passthrough();

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const Event = z.discriminatedUnion('event', [
  // Lifecycle
  TaskStartedEvent,
  StageChangeEvent,
  HeartbeatEvent,
  FallbackEvent,
  FallbackUnavailableEvent,
  EscalationEvent,
  EscalationUnavailableEvent,
  ReviewDecisionEvent,
  VerifyStepEvent,
  VerifySkippedEvent,
  ReadOnlyReviewQualityEvent,
  ReadOnlyReviewTerminalEvent,
  StallAbortEvent,
  TimeCheckEvent,
  CostCheckEvent,
  BatchCompletedEvent,
  BatchFailedEvent,
  TaskCompletedLocalEvent,
  // Explore
  ExploreParallelStartEvent,
  ExploreParallelEndEvent,
  ExploreInternalUnavailableEvent,
  ExploreExternalUnavailableEvent,
  ExploreSynthesizeStartEvent,
  ExploreSynthesizeEndEvent,
  ExploreThreadStartedEvent,
  ExploreThreadCompletedEvent,
  // Runner internals
  WorkerStartEvent,
  TurnStartEvent,
  TurnCompleteEvent,
  ToolCallEvent,
  TextEmissionEvent,
  // Cloud-bound
  TaskCompletedCloudEvent,
  SessionStartedCloudEvent,
  InstallChangedCloudEvent,
  SkillInstalledCloudEvent,
]);

export type EventType = z.infer<typeof Event>;

/** Cloud-bound event discriminator values — used by TelemetrySink to filter. */
export const CLOUD_EVENT_NAMES = new Set([
  'task.completed',
  'session.started',
  'install.changed',
  'skill.installed',
] as const);

// ---------------------------------------------------------------------------
// Schema index for coverage invariants and emit-time validation
// ---------------------------------------------------------------------------

/**
 * Map from event discriminator to its full-envelope Zod schema.
 *
 * Each schema validates the **complete persisted envelope** (including the
 * `event: <name>` discriminator field), not just the caller-supplied payload.
 * This makes one schema authoritative for both emit and ingest.
 *
 * Used by the telemetry coverage invariant test and by the emit-time
 * validator (NODE_ENV=test|development).
 */
export const EventSchemas: Record<string, z.ZodType> = {
  // Lifecycle
  task_started:               TaskStartedEvent,
  stage_change:               StageChangeEvent,
  heartbeat:                  HeartbeatEvent,
  fallback:                   FallbackEvent,
  fallback_unavailable:       FallbackUnavailableEvent,
  escalation:                 EscalationEvent,
  escalation_unavailable:     EscalationUnavailableEvent,
  review_decision:            ReviewDecisionEvent,
  verify_step:                VerifyStepEvent,
  verify_skipped:             VerifySkippedEvent,
  'read_only_review.quality':  ReadOnlyReviewQualityEvent,
  'read_only_review.terminal': ReadOnlyReviewTerminalEvent,
  stall_abort:                StallAbortEvent,
  time_check:                 TimeCheckEvent,
  cost_check:                 CostCheckEvent,
  task_completed:             TaskCompletedLocalEvent,
  batch_completed:            BatchCompletedEvent,
  batch_failed:               BatchFailedEvent,
  // Explore
  explore_parallel_start:         ExploreParallelStartEvent,
  explore_parallel_end:           ExploreParallelEndEvent,
  explore_internal_unavailable:   ExploreInternalUnavailableEvent,
  explore_external_unavailable:   ExploreExternalUnavailableEvent,
  explore_synthesize_start:       ExploreSynthesizeStartEvent,
  explore_synthesize_end:         ExploreSynthesizeEndEvent,
  explore_thread_started:         ExploreThreadStartedEvent,
  explore_thread_completed:       ExploreThreadCompletedEvent,
  // Runner internals
  worker_start:    WorkerStartEvent,
  turn_start:      TurnStartEvent,
  turn_complete:   TurnCompleteEvent,
  tool_call:       ToolCallEvent,
  text_emission:   TextEmissionEvent,
  // Cloud-bound
  'task.completed':   TaskCompletedCloudEvent,
  'session.started':  SessionStartedCloudEvent,
  'install.changed':  InstallChangedCloudEvent,
  'skill.installed':  SkillInstalledCloudEvent,
};

// ---------------------------------------------------------------------------
// EventBuilder — typed constructors per event kind
//
// One constructor per event discriminator. Each auto-fills `ts` and returns
// the fully-typed envelope. This closes the event-type catalog at compile
// time: callers can't misspell an event name or omit a required field.
// ---------------------------------------------------------------------------

export const EventBuilder = {
  // -- Lifecycle (task-level) -------------------------------------------------

  taskStarted(params: {
    batchId: string;
    taskIndex: number;
    route: z.infer<typeof RouteEnum>;
    cwd: string;
  }): z.infer<typeof TaskStartedEvent> {
    return { event: 'task_started', ts: ts(), ...params };
  },

  stageChange(params: {
    batchId: string;
    taskIndex: number;
    from: string;
    to: string;
    attempt?: number;
    attemptCap?: number;
    implTier?: z.infer<typeof TierEnum>;
    reviewerTier?: z.infer<typeof TierEnum>;
    escalated?: boolean;
  }): z.infer<typeof StageChangeEvent> {
    return { event: 'stage_change', ts: ts(), ...params } as z.infer<typeof StageChangeEvent>;
  },

  heartbeat(params: {
    batchId: string;
    taskIndex: number;
    elapsed: string;
    stage: string;
    round?: number;
    cap?: number;
    tools: number;
    read: number;
    wrote: number;
    text: number;
    cost: number | null;
    idle_ms: number;
    stage_idle_ms: number;
  }): z.infer<typeof HeartbeatEvent> {
    return { event: 'heartbeat', ts: ts(), ...params };
  },

  fallback(params: {
    batchId: string;
    taskIndex: number;
    loop: z.infer<typeof DiagLoopEnum>;
    attempt: number;
    role: z.infer<typeof DiagRoleEnum>;
    assignedTier: z.infer<typeof TierEnum>;
    usedTier: z.infer<typeof TierEnum>;
    reason: z.infer<typeof DiagReasonEnum>;
    triggeringStatus?: z.infer<typeof RunStatusEnum>;
    violatesSeparation: boolean;
    fallbackSeparationRespected?: boolean;
    assignedIdentity?: {
      providerType: string;
      normalizedEndpoint: string;
      modelId: string;
    } | null;
    usedIdentity?: {
      providerType: string;
      normalizedEndpoint: string;
      modelId: string;
    } | null;
  }): z.infer<typeof FallbackEvent> {
    return { event: 'fallback', ts: ts(), ...params };
  },

  fallbackUnavailable(params: {
    batchId: string;
    taskIndex: number;
    loop: z.infer<typeof DiagLoopEnum>;
    attempt: number;
    role: z.infer<typeof DiagRoleEnum>;
    assignedTier: z.infer<typeof TierEnum>;
    reason: z.infer<typeof DiagReasonEnum>;
  }): z.infer<typeof FallbackUnavailableEvent> {
    return { event: 'fallback_unavailable', ts: ts(), ...params };
  },

  escalation(params: {
    batchId: string;
    taskIndex: number;
    loop: z.infer<typeof DiagLoopEnum>;
    attempt: number;
    baseTier: z.infer<typeof TierEnum>;
    implTier: z.infer<typeof TierEnum>;
    reviewerTier: z.infer<typeof TierEnum>;
  }): z.infer<typeof EscalationEvent> {
    return { event: 'escalation', ts: ts(), ...params };
  },

  escalationUnavailable(params: {
    batchId: string;
    taskIndex: number;
    loop: z.infer<typeof DiagLoopEnum>;
    attempt: number;
    role: z.infer<typeof DiagRoleEnum>;
    wantedTier: z.infer<typeof TierEnum>;
    reason: z.infer<typeof DiagReasonEnum>;
  }): z.infer<typeof EscalationUnavailableEvent> {
    return { event: 'escalation_unavailable', ts: ts(), ...params };
  },

  reviewDecision(params: {
    batchId: string;
    taskIndex: number;
    stage: z.infer<typeof DiagLoopEnum>;
    verdict: z.infer<typeof ReviewVerdictEnum>;
    round: number;
  }): z.infer<typeof ReviewDecisionEvent> {
    return { event: 'review_decision', ts: ts(), ...params };
  },

  verifyStep(params: {
    batchId: string;
    taskIndex: number;
    command: string;
    status: 'passed' | 'failed' | 'error';
    exitCode?: number;
    signal?: string;
    durationMs: number;
    errorMessage?: string;
  }): z.infer<typeof VerifyStepEvent> {
    return { event: 'verify_step', ts: ts(), ...params };
  },

  verifySkipped(params: {
    batchId: string;
    taskIndex: number;
    reason: z.infer<typeof VerifySkipReasonEnum>;
    stage: string;
  }): z.infer<typeof VerifySkippedEvent> {
    return { event: 'verify_skipped', ts: ts(), ...params };
  },

  readOnlyReviewQuality(params: {
    batchId: string;
    taskIndex: number;
    route: string;
    verdict: z.infer<typeof ReviewVerdictEnum>;
    iterationIndex: number;
    findingsReviewed: number;
    meanConfidence: number | null;
    durationMs: number;
    costUSD: number | null;
  }): z.infer<typeof ReadOnlyReviewQualityEvent> {
    return { event: 'read_only_review.quality', ts: ts(), ...params };
  },

  readOnlyReviewTerminal(params: {
    batchId: string;
    taskIndex: number;
    route: string;
    roundsUsed: number;
    finalQualityVerdict: z.infer<typeof ReviewVerdictEnum>;
    costUSD: number | null;
    durationMs: number;
  }): z.infer<typeof ReadOnlyReviewTerminalEvent> {
    return { event: 'read_only_review.terminal', ts: ts(), ...params };
  },

  stallAbort(params: {
    batchId: string;
    taskIndex: number;
    idle_ms: number;
    threshold_ms: number;
  }): z.infer<typeof StallAbortEvent> {
    return { event: 'stall_abort', ts: ts(), ...params };
  },

  timeCheck(params: {
    batchId: string;
    taskIndex: number;
    stage: string;
    tripped: boolean;
    wallClockMs: number;
    timeoutMs: number;
  }): z.infer<typeof TimeCheckEvent> {
    return { event: 'time_check', ts: ts(), ...params };
  },

  costCheck(params: {
    batchId: string;
    taskIndex: number;
    stage: string;
    tripped: boolean;
    cost_used_usd: number;
    cost_cap_usd: number;
    cost_available: boolean;
  }): z.infer<typeof CostCheckEvent> {
    return { event: 'cost_check', ts: ts(), ...params };
  },

  taskCompleted(params: {
    batchId: string;
    taskIndex: number;
    status: string;
    workerStatus: string | null;
    turns: number;
    durationMs: number | null;
    filesRead: number;
    filesWritten: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedNonReadTokens: number;
    costUSD: number | null;
    taskMaxIdleMs: number | null;
    stallTriggered: boolean;
    stages: string;
  } & Record<string, unknown>): z.infer<typeof TaskCompletedLocalEvent> {
    return { event: 'task_completed', ts: ts(), ...params } as z.infer<typeof TaskCompletedLocalEvent>;
  },

  // -- Lifecycle (batch-level) ------------------------------------------------

  batchCompleted(params: {
    batchId: string;
    tool: string;
    durationMs: number;
    taskCount: number;
  }): z.infer<typeof BatchCompletedEvent> {
    return { event: 'batch_completed', ts: ts(), ...params };
  },

  batchFailed(params: {
    batchId: string;
    tool: string;
    durationMs: number;
    errorCode: string;
    errorMessage: string;
  }): z.infer<typeof BatchFailedEvent> {
    return { event: 'batch_failed', ts: ts(), ...params };
  },

  // -- Explore (batch-level) --------------------------------------------------

  exploreParallelStart(params: {
    batchId: string;
    internalRoute: string;
    externalRoute: string;
  }): z.infer<typeof ExploreParallelStartEvent> {
    return { event: 'explore_parallel_start', ts: ts(), ...params };
  },

  exploreParallelEnd(params: {
    batchId: string;
    internalOk: boolean;
    externalOk: boolean;
    internalDurationMs: number;
    externalDurationMs: number;
  }): z.infer<typeof ExploreParallelEndEvent> {
    return { event: 'explore_parallel_end', ts: ts(), ...params };
  },

  exploreInternalUnavailable(params: {
    batchId: string;
    reason: string;
  }): z.infer<typeof ExploreInternalUnavailableEvent> {
    return { event: 'explore_internal_unavailable', ts: ts(), ...params };
  },

  exploreExternalUnavailable(params: {
    batchId: string;
    reason: string;
  }): z.infer<typeof ExploreExternalUnavailableEvent> {
    return { event: 'explore_external_unavailable', ts: ts(), ...params };
  },

  exploreSynthesizeStart(params: {
    batchId: string;
    internalAvailable: boolean;
    externalAvailable: boolean;
  }): z.infer<typeof ExploreSynthesizeStartEvent> {
    return { event: 'explore_synthesize_start', ts: ts(), ...params };
  },

  exploreSynthesizeEnd(params: {
    batchId: string;
    threadCount: number;
    recommendedNextStep: boolean;
    durationMs: number;
  }): z.infer<typeof ExploreSynthesizeEndEvent> {
    return { event: 'explore_synthesize_end', ts: ts(), ...params };
  },

  exploreThreadStarted(params: {
    batchId: string;
    threadIndex: number;
  }): z.infer<typeof ExploreThreadStartedEvent> {
    return { event: 'explore_thread_started', ts: ts(), ...params };
  },

  exploreThreadCompleted(params: {
    batchId: string;
    threadIndex: number;
  }): z.infer<typeof ExploreThreadCompletedEvent> {
    return { event: 'explore_thread_completed', ts: ts(), ...params };
  },

  // -- Runner internals (task-level) ------------------------------------------

  workerStart(params: {
    batchId: string;
    taskIndex: number;
    model: string;
    providerType: z.infer<typeof ProviderTypeEnum>;
    tier: z.infer<typeof TierEnum>;
  }): z.infer<typeof WorkerStartEvent> {
    return { event: 'worker_start', ts: ts(), ...params };
  },

  turnStart(params: {
    batchId: string;
    taskIndex: number;
    turnIndex: number;
    providerType: z.infer<typeof ProviderTypeEnum>;
    model: string;
  }): z.infer<typeof TurnStartEvent> {
    return { event: 'turn_start', ts: ts(), ...params };
  },

  turnComplete(params: {
    batchId: string;
    taskIndex: number;
    turnIndex: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedNonReadTokens: number;
    costUSD: number;
    durationMs: number;
    providerType: z.infer<typeof ProviderTypeEnum>;
    model: string;
  }): z.infer<typeof TurnCompleteEvent> {
    return { event: 'turn_complete', ts: ts(), ...params };
  },

  toolCall(params: {
    batchId: string;
    taskIndex: number;
    tool: string;
    turnIndex: number;
  }): z.infer<typeof ToolCallEvent> {
    return { event: 'tool_call', ts: ts(), ...params };
  },

  textEmission(params: {
    batchId: string;
    taskIndex: number;
    chars: number;
    turnIndex: number;
  }): z.infer<typeof TextEmissionEvent> {
    return { event: 'text_emission', ts: ts(), ...params };
  },

  // -- Cloud-bound ------------------------------------------------------------

  taskCompletedCloud(params: {
    route: z.infer<typeof RouteEnum>;
    agentType: z.infer<typeof TierEnum>;
    capabilities: Array<'web_search' | 'web_fetch' | 'other'>;
    toolMode: 'none' | 'readonly' | 'no-shell' | 'full';
    triggeredFromSkill: string;
    client: string;
    fileCountBucket: '0' | '1-5' | '6-20' | '21-50' | '51+';
    durationBucket: '<10s' | '10s-1m' | '1m-5m' | '5m-30m' | '30m+';
    costBucket: '$0' | '<$0.01' | '$0.01-$0.10' | '$0.10-$1' | '$1+';
    savedCostBucket: '$0' | '<$0.10' | '$0.10-$1' | '$1+' | 'unknown';
    implementerModelFamily: string;
    implementerModel: string;
    terminalStatus: 'ok' | 'incomplete' | 'timeout' | 'error' | 'cost_exceeded' | 'brief_too_vague' | 'unavailable';
    workerStatus: z.infer<typeof WorkerStatusEnum>;
    errorCode: string | null;
    escalated: boolean;
    fallbackTriggered: boolean;
    topToolNames: string[];
    stages: Record<string, unknown>;
  } & Record<string, unknown>): z.infer<typeof TaskCompletedCloudEvent> {
    return { event: 'task.completed', ts: ts(), ...params } as z.infer<typeof TaskCompletedCloudEvent>;
  },

  sessionStartedCloud(params: {
    configFlavor: Record<string, unknown>;
    providersConfigured: Array<'claude' | 'openai-compatible' | 'codex'>;
  } & Record<string, unknown>): z.infer<typeof SessionStartedCloudEvent> {
    return { event: 'session.started', ts: ts(), ...params } as z.infer<typeof SessionStartedCloudEvent>;
  },

  installChangedCloud(params: {
    fromVersion: string | null;
    toVersion: string;
    trigger: 'fresh_install' | 'upgrade' | 'downgrade';
  } & Record<string, unknown>): z.infer<typeof InstallChangedCloudEvent> {
    return { event: 'install.changed', ts: ts(), ...params } as z.infer<typeof InstallChangedCloudEvent>;
  },

  skillInstalledCloud(params: {
    skill: string;
    client: string;
  } & Record<string, unknown>): z.infer<typeof SkillInstalledCloudEvent> {
    return { event: 'skill.installed', ts: ts(), ...params } as z.infer<typeof SkillInstalledCloudEvent>;
  },
};
