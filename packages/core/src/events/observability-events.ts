import { z } from 'zod';
import {
  TaskBase, BatchBase,
  RouteEnum, TierEnum, DiagLoopEnum, DiagRoleEnum, DiagReasonEnum,
  ProviderTypeEnum, InternalRunStatusEnum, ReviewVerdictEnum, VerifyOutcomeEnum,
  VerifySkipReasonEnum, WorkerStatusEnum,
} from './event-base.js';

export {
  RouteEnum, TierEnum, DiagLoopEnum, DiagRoleEnum, DiagReasonEnum,
  ProviderTypeEnum, InternalRunStatusEnum, ReviewVerdictEnum, VerifyOutcomeEnum,
  VerifySkipReasonEnum, WorkerStatusEnum,
} from './event-base.js';

// === Lifecycle events (14) ===

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
  triggeringStatus: InternalRunStatusEnum.optional(),
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

// === Runner-internal events (5) ===

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

// Cloud-bound events live in cloud-events.ts; re-imported here for the
// discriminated union and schema index below.
import {
  TaskCompletedCloudEvent,
  SessionStartedCloudEvent,
  InstallChangedCloudEvent,
  SkillInstalledCloudEvent,
} from './cloud-events.js';
export {
  TaskCompletedCloudEvent,
  SessionStartedCloudEvent,
  InstallChangedCloudEvent,
  SkillInstalledCloudEvent,
  CLOUD_EVENT_NAMES,
} from './cloud-events.js';

// === Discriminated union ===

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

// === Schema index for coverage invariants and emit-time validation ===

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

