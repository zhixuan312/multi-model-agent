import { z } from 'zod';
import { ModelFamilyEnum } from '../config/model-profile-registry.js';

export const SCHEMA_VERSION = 4;

export const STRICT_ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9_.:+/@]{0,119}$/;

// ── Batch wrapper (§3.1) ─────────────────────────────────────────────────

const VersionString = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  )
  .max(64);

export const Os = z.enum(['darwin', 'linux', 'win32', 'other']);

export const BatchWrapperSchema = z.object({
  schemaVersion: z.literal(4),
  installId: z.string().uuid(),
  mmagentVersion: VersionString,
  os: Os,
  nodeMajor: z.number().int().min(22).max(99),
}).strict();

// ── Enums shared across stages and top-level ─────────────────────────────
//
// ConcernCategory lives at `types/enums.ts` per architecture.md:209;
// re-exported here so existing `import { ConcernCategory } from
// '..events/telemetry-types'` paths keep working.

export { ConcernCategory } from '../types/enums.js';
// We need a direct local binding for `z.array(_ConcernCategory)` below; the
// re-export above is the public path, the local import is the internal one.
import { ConcernCategory as _ConcernCategory } from '../types/enums.js';

import { ErrorCodeSchema } from '../error-codes.js';
export const ErrorCode = ErrorCodeSchema;

export const SeverityBin = z.enum(['critical', 'high', 'medium', 'low']);

export const FindingsBySeveritySchema = z.object({
  critical: z.number().int().min(0).max(200),
  high: z.number().int().min(0).max(200),
  medium: z.number().int().min(0).max(200),
  low: z.number().int().min(0).max(200),
}).strict();

// Shared base: matches the TokenUsage interface in runners/types.ts.
// Single source of truth for canonical 4-field token shape.
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedReadTokens: z.number().int().min(0),
  cachedNonReadTokens: z.number().int().min(0),
});

export const TierUsageSchema = TokenUsageSchema.extend({
  model: z.string(),
  costUSD: z.number().nullable(),
});

// ── Stage entry (§3.3) ───────────────────────────────────────────────────

const StageNameEnum = z.enum([
  'implementing',
  'spec_review',
  'spec_rework',
  'quality_review',
  'quality_rework',
  'diff_review',
  'verifying',
  'committing',
]);

// Base fields shared by all stage variants.
// Field set kept in lockstep with TokenUsageSchema — when a new token class
// is added there, the token fields here must be updated too.
export const StageEntryBase = z.object({
  name: StageNameEnum,
  round: z.number().int().min(0),
  model: z.string().regex(STRICT_ID_REGEX),
  tier: z.enum(['standard', 'complex']),
  durationMs: z.number().int().min(0).max(3_600_000),
  costUSD: z.number().min(0).max(100).nullable(),
  inputTokens: z.number().int().min(0).max(5_000_000),
  outputTokens: z.number().int().min(0).max(500_000),
  cachedReadTokens: z.number().int().min(0).max(5_000_000).nullable(),
  cachedNonReadTokens: z.number().int().min(0).max(5_000_000).nullable(),
  toolCallCount: z.number().int().min(0).max(5000),
  filesReadCount: z.number().int().min(0).max(5000),
  filesWrittenCount: z.number().int().min(0).max(5000),
  turnCount: z.number().int().min(0).max(250),
  maxIdleMs: z.number().int().min(0).max(1_200_000),
  totalIdleMs: z.number().int().min(0).max(3_600_000),
});

export const ReviewStageEntrySchema = StageEntryBase.extend({
  name: z.enum(['spec_review', 'quality_review', 'diff_review']),
  verdict: z.enum(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'annotated', 'not_applicable']),
  roundsUsed: z.number().int().min(1).max(10),
  concernCategories: z.array(_ConcernCategory).max(9),
  findingsBySeverity: FindingsBySeveritySchema,
}).strict();

export const ReworkStageEntrySchema = StageEntryBase.extend({
  name: z.enum(['spec_rework', 'quality_rework']),
  triggeringConcernCategories: z.array(_ConcernCategory).max(9),
}).strict();

export const VerifyStageEntrySchema = StageEntryBase.extend({
  name: z.literal('verifying'),
  outcome: z.enum(['passed', 'failed', 'skipped', 'not_applicable']),
  skipReason: z.enum(['no_command', 'dirty_worktree', 'not_applicable', 'other']).nullable(),
}).strict();

export const CommitStageEntrySchema = StageEntryBase.extend({
  name: z.literal('committing'),
  filesCommittedCount: z.number().int().min(0).max(1000),
  branchCreated: z.boolean(),
}).strict();

export const ImplementStageEntrySchema = StageEntryBase.extend({
  name: z.literal('implementing'),
}).strict();

export const StageEntrySchema = z.discriminatedUnion('name', [
  ImplementStageEntrySchema,
  ReviewStageEntrySchema,
  ReworkStageEntrySchema,
  VerifyStageEntrySchema,
  CommitStageEntrySchema,
]);

// ── Task completed event (§3.2) ──────────────────────────────────────────

export const TaskCompletedEventSchema = z.object({
  // Identity
  eventId: z.string().uuid(),
  route: z.enum(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'retry', 'investigate', 'register-context-block']),
  client: z.string().regex(STRICT_ID_REGEX),

  // Configuration
  agentType: z.enum(['standard', 'complex']),
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  reviewPolicy: z.enum(['full', 'quality_only', 'diff_only', 'none']),
  verifyCommandPresent: z.boolean(),

  // Model
  implementerModel: z.string().regex(STRICT_ID_REGEX),
  implementerTier: z.enum(['standard', 'complex']),
  mainModel: z.string().nullable(),
  mainModelFamily: ModelFamilyEnum,

  // Tier-level usage breakdown (§3.2, §3.3)
  tierUsage: z.object({
    standard: TierUsageSchema.optional(),
    complex: TierUsageSchema.optional(),
  }),

  // Outcome
  terminalStatus: z.enum(['ok', 'incomplete', 'timeout', 'error', 'cost_exceeded', 'brief_too_vague', 'unavailable']),
  workerStatus: z.enum(['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed', 'review_loop_capped']),
  errorCode: ErrorCode.nullable(),

  // Token economics
  inputTokens: z.number().int().min(0).max(5_000_000),
  outputTokens: z.number().int().min(0).max(500_000),
  cachedReadTokens: z.number().int().min(0).max(5_000_000).nullable(),
  cachedNonReadTokens: z.number().int().min(0).max(5_000_000).nullable(),

  // Run totals
  totalDurationMs: z.number().int().min(0).max(86_400_000),
  totalCostUSD: z.number().min(0).max(800).nullable(),
  mainEquivalentCostUSD: z.number().nullable(),
  costDeltaVsMainUSD: z.number().nullable(),

  // Lifecycle counts
  concernCount: z.number().int().min(0).max(150),
  escalationCount: z.number().int().min(0).max(20),
  fallbackCount: z.number().int().min(0).max(20),

  // Operational signals
  stallCount: z.number().int().min(0).max(20),
  taskMaxIdleMs: z.number().int().min(0).max(1_200_000),
  sandboxViolationCount: z.number().int().min(0).max(100),

  // Stages array
  stages: z.array(StageEntrySchema).min(0).max(16),

  // Validation warnings populated by the recorder before enqueue;
  // absent for healthy events. Each entry carries the rule name
  // (e.g. "R1: ...") and the Zod issue path (empty string = cross-field).
  validation_warnings: z.array(z.object({
    rule: z.string(),
    path: z.string(),
  })).optional(),
}).strict();

// ── Upload batch ─────────────────────────────────────────────────────────

export const UploadBatchSchema = z.object({
  schemaVersion: z.literal(4),
  installId: z.string().uuid(),
  mmagentVersion: VersionString,
  os: Os,
  nodeMajor: z.number().int().min(22).max(99),
  generation: z.number().int().min(0).optional(),
  events: z.array(TaskCompletedEventSchema).min(1).max(500),
}).strict();

// ── Super-refinement: R1–R15 (§3.4) ──────────────────────────────────────

const qualityOnlyRoutes = new Set(['audit', 'review', 'verify', 'debug', 'investigate']);
const reviewedRoutes = new Set(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'investigate']);
const reworkStages = new Set(['spec_rework', 'quality_rework']);
const reviewStages = new Set(['spec_review', 'quality_review', 'diff_review']);

export const ValidatedTaskCompletedEventSchema = TaskCompletedEventSchema.superRefine((event, ctx) => {
  // R1: ok terminalStatus implies non-failed worker outcome and no errorCode
  if (event.terminalStatus === 'ok') {
    if (!['done', 'done_with_concerns'].includes(event.workerStatus)) {
      ctx.addIssue({ code: 'custom', message: 'R1: terminalStatus=ok requires workerStatus done|done_with_concerns' });
    }
    if (event.errorCode !== null) {
      ctx.addIssue({ code: 'custom', message: 'R1: terminalStatus=ok requires errorCode=null' });
    }
  }

  // R2.1: empty stages only allowed for brief_too_vague and error
  if (event.stages.length === 0 && !['brief_too_vague', 'error'].includes(event.terminalStatus)) {
    ctx.addIssue({ code: 'custom', message: 'R2.1: empty stages only allowed for brief_too_vague|error' });
  }

  // R4: totalDurationMs >= sum of stage durationMs (not strictly equal due to overhead)
  const stageDurationSum = event.stages.reduce((s, st) => s + st.durationMs, 0);
  if (stageDurationSum > event.totalDurationMs) {
    ctx.addIssue({ code: 'custom', message: 'R4: sum of stage durationMs must not exceed totalDurationMs' });
  }

  // R5: top-level token counts must not exceed the sum of stage token counts.
  // Clamping may reduce the top-level total below the stage sum (e.g. when
  // every stage is at its per-stage cap and the sum exceeds the top-level
  // schema bound). The invariant is: top-level ≤ sum of stages.
  const tokenSum = event.stages.reduce(
    (acc, st) => ({
      input: acc.input + st.inputTokens,
      output: acc.output + st.outputTokens,
      cachedRead: acc.cachedRead + (st.cachedReadTokens ?? 0),
      cachedNonRead: acc.cachedNonRead + (st.cachedNonReadTokens ?? 0),
    }),
    { input: 0, output: 0, cachedRead: 0, cachedNonRead: 0 },
  );
  if (
    tokenSum.input < event.inputTokens ||
    tokenSum.output < event.outputTokens ||
    tokenSum.cachedRead < (event.cachedReadTokens ?? 0) ||
    tokenSum.cachedNonRead < (event.cachedNonReadTokens ?? 0)
  ) {
    ctx.addIssue({ code: 'custom', message: 'R5: top-level token counts must not exceed sum of stage token counts' });
  }

  // R6b: non-negativity of cachedReadTokens and cachedNonReadTokens is
  // enforced by z.number().int().min(0). The soft-warning case
  // (cachedReadTokens + cachedNonReadTokens > 100 × inputTokens) lives in
  // recorder.ts validation_warnings; see Task 11.5.

  // R7: (name, round) uniqueness across the stages array.
  const seenNameRound = new Set<string>();
  for (const st of event.stages) {
    const key = `${st.name}:${st.round}`;
    if (seenNameRound.has(key)) {
      ctx.addIssue({ code: 'custom', message: `R7: duplicate (name, round) pair: ${key}` });
    }
    seenNameRound.add(key);
  }

  // cost-sum: totalCostUSD must approximately equal sum of stage costUSD
  // (float comparison with tolerance). When totalCostUSD is null (honest-null
  // because a contributing stage has null costUSD), skip this check.
  if (event.totalCostUSD !== null && event.stages.every(st => st.costUSD !== null)) {
    const costSum = event.stages.reduce((s, st) => s + (st.costUSD as number), 0);
    if (Math.abs(costSum - event.totalCostUSD) > 0.02) {
      ctx.addIssue({ code: 'custom', message: 'cost-sum: totalCostUSD must approximately equal sum of stage costUSD' });
    }
  }

  // R8: verification outcome only on delegate, execute-plan, verify routes
  const verifyRoutes = new Set(['delegate', 'execute-plan', 'verify']);
  for (const st of event.stages) {
    if (st.name === 'verifying' && !verifyRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: 'R8: verifying stage only allowed on delegate|execute-plan|verify routes' });
    }
  }

  // R9: review stages only on reviewed routes
  for (const st of event.stages) {
    if (reviewStages.has(st.name) && !reviewedRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: `R9: ${st.name} stage only allowed on reviewed routes` });
    }
  }

  // R10: quality_only routes must not have spec_review, diff_review, or rework stages
  // R10b: no rework on quality_only
  // R10c: annotated verdict only on quality_only routes
  for (const st of event.stages) {
    if (qualityOnlyRoutes.has(event.route)) {
      if (reviewStages.has(st.name) && st.name !== 'quality_review') {
        ctx.addIssue({ code: 'custom', message: 'R10: non-quality review stage on quality_only route' });
      }
      if (reworkStages.has(st.name)) {
        ctx.addIssue({ code: 'custom', message: 'R10b: rework stages not allowed on quality_only routes' });
      }
    }
    if ('verdict' in st && st.verdict === 'annotated' && !qualityOnlyRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: 'R10c: annotated verdict only allowed on quality_only routes' });
    }
  }

  // R11: concernCount in [0, 150], escalationCount in [0, 20], fallbackCount in [0, 20]
  // (enforced by Zod schema bounds)

  // R12: stallCount in [0, 20], sandboxViolationCount in [0, 100]
  // (enforced by Zod schema bounds)

  // R13: totalDurationMs in [0, 86_400_000]
  // (enforced by Zod schema bounds)

  // R14: totalCostUSD in [0, 800] or null
  // (enforced by Zod schema bounds)

  // R16: rework stages require their parent review stage in the same event
  const stageNames = new Set((event.stages ?? []).map(s => s.name));
  if (stageNames.has('spec_rework') && !stageNames.has('spec_review')) {
    ctx.addIssue({ code: 'custom', message: 'R16: spec_rework requires spec_review in the same event' });
  }
  if (stageNames.has('quality_rework') && !stageNames.has('quality_review')) {
    ctx.addIssue({ code: 'custom', message: 'R16: quality_rework requires quality_review in the same event' });
  }
});

// ── Wire-telemetry record (§3.5) ─────────────────────────────────────────
// Validates the wire shape emitted by buildWirePayload. v4.0.3 unified
// internal + wire to mainModel/mainModelFamily — no more rename shim.

export const WireTelemetryRecordSchema = z.object({
  mainModel: z.string().nullable(),
  mainModelFamily: ModelFamilyEnum,
}).passthrough();

// ── Inferred TS types ────────────────────────────────────────────────────

export type BatchWrapper = z.infer<typeof BatchWrapperSchema>;
export type StageEntryType = z.infer<typeof StageEntrySchema>;
export type TaskCompletedEventType = z.infer<typeof TaskCompletedEventSchema>;
export type UploadBatchType = z.infer<typeof UploadBatchSchema>;
export type WireTelemetryRecord = z.infer<typeof WireTelemetryRecordSchema>;
export type { ConcernCategoryType } from '../types/enums.js';
export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type FindingsBySeverity = z.infer<typeof FindingsBySeveritySchema>;
