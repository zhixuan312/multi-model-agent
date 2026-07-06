import { z } from 'zod';
import { ModelFamilyEnum } from '../config/model-profile-registry.js';

export const SCHEMA_VERSION = 6;

export const STRICT_ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9_.:+/@]{0,119}$/;

// ── Version and environment strings ──────────────────────────────────────

const VersionString = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  )
  .max(64);

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
  'review',
  'rework',
  'annotating',
  'committing',
]);

// Base fields shared by all stage variants.
// Field set kept in lockstep with TokenUsageSchema — when a new token class
// is added there, the token fields here must be updated too.
export const StageEntryBase = z.object({
  name: StageNameEnum,
  round: z.number().int().min(0),
  model: z.string().regex(STRICT_ID_REGEX),
  tier: z.enum(['standard', 'complex', 'main']),
  durationMs: z.number().int().min(0).max(3_600_000),
  costUSD: z.number().min(0).max(500).nullable(),
  inputTokens: z.number().int().min(0).max(100_000_000),
  outputTokens: z.number().int().min(0).max(2_000_000),
  cachedReadTokens: z.number().int().min(0).max(100_000_000).nullable(),
  cachedNonReadTokens: z.number().int().min(0).max(100_000_000).nullable(),
  filesWrittenCount: z.number().int().min(0).max(5000),
  turnCount: z.number().int().min(0).max(250),
  maxIdleMs: z.number().int().min(0).max(1_200_000),
  totalIdleMs: z.number().int().min(0).max(3_600_000),
  mainCostUSD: z.number().nullable(),   // what this stage's tokens would have cost at the main model's rate (renamed from mainEquivalentCostUSD in 4.7.6 to match DB column main_cost_usd)
});

// 4.7.4+ standardization: findingsBySeverity + findingsOutcome and its
// companion booleans (outcomeInferred / outcomeMalformed) live ONLY at the
// top level of TaskCompletedEventSchema. Per-stage rows used to carry
// duplicates of these fields; they were lifted out so there is one
// authoritative source — the task as a whole has one final findings list
// and one final outcome, regardless of which stage produced them.
export const ReviewStageEntrySchema = StageEntryBase.extend({
  name: z.literal('review'),
  verdict: z.enum(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'annotated', 'not_applicable']),
  roundsUsed: z.number().int().min(1).max(10),
  concernCategories: z.array(_ConcernCategory).max(9),
}).strict();

export const ReworkStageEntrySchema = StageEntryBase.extend({
  name: z.literal('rework'),
  triggeringConcernCategories: z.array(_ConcernCategory).max(9),
}).strict();

export const AnnotatingStageEntrySchema = StageEntryBase.extend({
  name: z.literal('annotating'),
  outcome: z.enum(['passed', 'failed', 'skipped', 'not_applicable', 'transformed']),
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
  AnnotatingStageEntrySchema,
  CommitStageEntrySchema,
]);

// ── Task completed event (§3.2) ──────────────────────────────────────────

export const TaskCompletedEventSchema = z.object({
  // Identity
  eventId: z.string().uuid(),
  route: z.enum(['delegate', 'audit', 'review', 'debug', 'execute-plan', 'retry', 'investigate', 'research', 'journal-record', 'journal-recall', 'register-context-block', 'orchestrate', 'spec', 'plan']),
  subtype: z.string().min(1).max(64).nullable().optional(),
  client: z.string().regex(STRICT_ID_REGEX),

  // Configuration
  agentType: z.enum(['standard', 'complex', 'main']),
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  // reviewPolicy is per-task intent, not outcome.
  // v6: collapsed to 'reviewed' (any active review) | 'none'.
  // Whether review actually ran is in stages.review.outcome.
  // intent='reviewed' + outcome='skipped' is legal (e.g., implement failed;
  // read route; review-skip gate triggered).
  reviewPolicy: z.enum(['reviewed', 'none']),

  // Model
  implementerModel: z.string().regex(STRICT_ID_REGEX),
  implementerTier: z.enum(['standard', 'complex', 'main']),
  mainModel: z.string().nullable(),
  mainModelFamily: ModelFamilyEnum,

  // Tier-level usage breakdown (§3.2, §3.3)
  tierUsage: z.object({
    standard: TierUsageSchema.optional(),
    complex: TierUsageSchema.optional(),
  }),

  // Outcome
  terminalStatus: z.enum(['ok', 'incomplete', 'timeout', 'error', 'brief_too_vague', 'unavailable']),
  workerStatus: z.enum(['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed', 'review_loop_capped']),
  // errorCode is non-null whenever terminalStatus === 'error'.
  // For reviewer-rejection paths, the code is one of:
  //   review_diff_rejected, review_quality_findings_unresolved, review_spec_rejected_terminal.
  // terminalStatus remains 'error' (no distinct 'review_rejected' status).
  // Disambiguate reviewer rejection from transport/runtime failure by reading errorCode.
  errorCode: ErrorCode.nullable(),

  // Token economics
  inputTokens: z.number().int().min(0).max(100_000_000),
  outputTokens: z.number().int().min(0).max(2_000_000),
  cachedReadTokens: z.number().int().min(0).max(100_000_000).nullable(),
  cachedNonReadTokens: z.number().int().min(0).max(100_000_000).nullable(),

  // Run totals
  totalDurationMs: z.number().int().min(0).max(86_400_000),
  totalCostUSD: z.number().min(0).max(5_000).nullable(),
  mainCostUSD: z.number().nullable(),
  costDeltaVsMainUSD: z.number().nullable(),

  // Lifecycle counts
  concernCount: z.number().int().min(0).max(150),
  // 4.7.4+ standardization: ALL findings-summary signals live at the top
  // level. Per-stage rows no longer carry these — there is one final
  // findings list per task and one final outcome, regardless of which
  // stage produced them. Backend + frontend read here and only here.
  findingsBySeverity: FindingsBySeveritySchema.optional(),
  findingsOutcome: z.enum(['found', 'clean', 'not_applicable']).nullable().optional(),
  findingsOutcomeReason: z.string().nullable().optional(),
  outcomeInferred: z.boolean().optional(),
  outcomeMalformed: z.boolean().optional(),
  escalationCount: z.number().int().min(0).max(20),
  fallbackCount: z.number().int().min(0).max(20),

  // Files changed — sourced from real git diff (sub-project A), not worker self-report.
  filesWrittenCount: z.number().int().min(0).max(5000),

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

// ── Super-refinement: R1–R15 (§3.4) ──────────────────────────────────────

const qualityOnlyRoutes = new Set(['audit', 'review', 'debug', 'investigate', 'journal-recall']);
// Every route EXCEPT orchestrate defaults to reviewPolicy='reviewed' (see
// unified-task.ts: `type === 'orchestrate' ? 'none' : reviewed`), so every one of them
// can legitimately emit a `review` stage. Omitting journal-recall / research /
// retry here made `toWireRecord` throw "R9: review stage only allowed on reviewed
// routes" and silently DROP their telemetry. List all reviewable routes.
const reviewedRoutes = new Set(['delegate', 'audit', 'review', 'debug', 'execute-plan', 'retry', 'investigate', 'research', 'journal-record', 'journal-recall']);

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

  // R9: review stage only on reviewed routes
  for (const st of event.stages) {
    if (st.name === 'review' && !reviewedRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: 'R9: review stage only allowed on reviewed routes' });
    }
  }

  // R10c: annotated verdict only on quality_only routes
  for (const st of event.stages) {
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

  // R16: rework stage requires the review stage in the same event
  const stageNames = new Set((event.stages ?? []).map(s => s.name));
  if (stageNames.has('rework') && !stageNames.has('review')) {
    ctx.addIssue({ code: 'custom', message: 'R16: rework requires review in the same event' });
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

export type TaskCompletedEventType = z.infer<typeof TaskCompletedEventSchema>;
export type WireTelemetryRecord = z.infer<typeof WireTelemetryRecordSchema>;
export type { ConcernCategoryType } from '../types/enums.js';
