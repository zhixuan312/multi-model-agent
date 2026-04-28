import { z } from 'zod';

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
]);

const TierEnum = z.enum(['standard', 'complex']);

const DiagLoopEnum = z.enum(['spec', 'quality', 'diff']);

const DiagRoleEnum = z.enum([
  'implementer', 'specReviewer', 'qualityReviewer', 'diffReviewer',
]);

const DiagReasonEnum = z.enum(['transport_failure', 'not_configured']);

const ProviderTypeEnum = z.enum(['claude', 'openai-compatible', 'codex']);

const RunStatusEnum = z.enum([
  'ok', 'incomplete', 'timeout', 'api_aborted', 'api_error',
  'network_error', 'error', 'brief_too_vague', 'cost_exceeded', 'unavailable',
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
  'review_loop_aborted', 'failed',
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
  tools: z.number().int().min(0),
  read: z.number().int().min(0),
  wrote: z.number().int().min(0),
  text: z.number().int().min(0),
  cost: z.number().min(0).nullable(),
  idleMs: z.number().int().min(0),
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
  findingsFlagged: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  costUSD: z.number().min(0).nullable(),
}).strict();

export const ReadOnlyReviewReworkEvent = TaskBase.extend({
  event: z.literal('read_only_review.rework'),
  route: z.string(),
  iterationIndex: z.number().int().min(1),
  triggeringIssues: z.number().int().min(0),
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
  idleMs: z.number().int().min(0),
  thresholdMs: z.number().int().min(0),
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
  costUSD: z.number().min(0).nullable(),
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
  ReadOnlyReviewReworkEvent,
  ReadOnlyReviewTerminalEvent,
  StallAbortEvent,
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

/** Cloud-bound event discriminator values — used by TelemetrySink to filter. */
export const CLOUD_EVENT_NAMES = new Set([
  'task.completed',
  'session.started',
  'install.changed',
  'skill.installed',
] as const);
