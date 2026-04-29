import { z } from 'zod';
import { ModelFamilyEnum } from '../routing/model-profiles.js';

export const SCHEMA_VERSION = 3;

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
  schemaVersion: z.literal(3),
  installId: z.string().uuid(),
  mmagentVersion: VersionString,
  os: Os,
  nodeMajor: z.number().int().min(22).max(99),
}).strict();

// ── Enums shared across stages and top-level ─────────────────────────────

export const ConcernCategory = z.enum([
  'missing_test',
  'scope_creep',
  'incomplete_impl',
  'style_lint',
  'security',
  'performance',
  'maintainability',
  'doc_gap',
  'other',
]);

export const ErrorCode = z.enum([
  'verify_command_error',
  'commit_metadata_invalid',
  'commit_metadata_repair_modified_files',
  'dirty_worktree',
  'diff_review_rejected',
  'runner_crash',
  'executor_error',
  'api_error',
  'network_error',
  'rate_limit_exceeded',
  'other',
]);

export const SeverityBin = z.enum(['high', 'medium', 'low', 'style']);

export const FindingsBySeveritySchema = z.object({
  high: z.number().int().min(0).max(50),
  medium: z.number().int().min(0).max(50),
  low: z.number().int().min(0).max(50),
  style: z.number().int().min(0).max(50),
}).strict();

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

// Base fields shared by all stage variants
const StageEntryBase = z.object({
  name: StageNameEnum,
  model: z.string().regex(STRICT_ID_REGEX),
  agentTier: z.enum(['standard', 'reasoning']),
  durationMs: z.number().int().min(0).max(3_600_000),
  costUSD: z.number().min(0).max(100),
  inputTokens: z.number().int().min(0).max(5_000_000),
  outputTokens: z.number().int().min(0).max(500_000),
  cachedTokens: z.number().int().min(0).max(5_000_000),
  reasoningTokens: z.number().int().min(0).max(500_000),
  toolCallCount: z.number().int().min(0).max(5000),
  filesReadCount: z.number().int().min(0).max(5000),
  filesWrittenCount: z.number().int().min(0).max(5000),
  turnCount: z.number().int().min(0).max(250),
  maxIdleMs: z.number().int().min(0).max(1_200_000).nullable(),
  totalIdleMs: z.number().int().min(0).max(3_600_000).nullable(),
});

export const ReviewStageEntrySchema = StageEntryBase.extend({
  name: z.enum(['spec_review', 'quality_review', 'diff_review']),
  verdict: z.enum(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'annotated', 'not_applicable']),
  roundsUsed: z.number().int().min(1).max(10),
  concernCategories: z.array(ConcernCategory).max(9),
  findingsBySeverity: FindingsBySeveritySchema,
}).strict();

export const ReworkStageEntrySchema = StageEntryBase.extend({
  name: z.enum(['spec_rework', 'quality_rework']),
  triggeringConcernCategories: z.array(ConcernCategory).max(9),
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
  route: z.enum(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'retry', 'investigate']),
  client: z.string().regex(STRICT_ID_REGEX),

  // Configuration
  agentType: z.enum(['standard', 'complex']),
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  capabilities: z.array(z.enum(['web_search', 'web_fetch', 'other'])).max(3),
  reviewPolicy: z.enum(['full', 'quality_only', 'diff_only', 'none']),
  verifyCommandPresent: z.boolean(),

  // Model
  implementerModel: z.string().regex(STRICT_ID_REGEX),

  // Outcome
  terminalStatus: z.enum(['ok', 'incomplete', 'timeout', 'error', 'cost_exceeded', 'brief_too_vague', 'unavailable']),
  workerStatus: z.enum(['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed', 'review_loop_aborted']),
  errorCode: ErrorCode.nullable(),
  parentModelFamily: ModelFamilyEnum,

  // Token economics
  inputTokens: z.number().int().min(0).max(5_000_000),
  outputTokens: z.number().int().min(0).max(500_000),
  cachedTokens: z.number().int().min(0).max(5_000_000),
  reasoningTokens: z.number().int().min(0).max(500_000),

  // Run totals
  totalDurationMs: z.number().int().min(0).max(86_400_000),
  totalCostUSD: z.number().min(0).max(800),
  totalSavedCostUSD: z.number().min(-800).max(800).nullable(),

  // Lifecycle counts
  concernCount: z.number().int().min(0).max(150),
  escalationCount: z.number().int().min(0).max(20),
  fallbackCount: z.number().int().min(0).max(20),

  // Operational signals
  stallCount: z.number().int().min(0).max(20),
  taskMaxIdleMs: z.number().int().min(0).max(1_200_000).nullable(),
  clarificationRequested: z.boolean(),
  briefQualityWarningCount: z.number().int().min(0).max(20),
  sandboxViolationCount: z.number().int().min(0).max(100),

  // Stages array
  stages: z.array(StageEntrySchema).min(0).max(8),
}).strict();

// ── Upload batch ─────────────────────────────────────────────────────────

export const UploadBatchSchema = z.object({
  schemaVersion: z.literal(3),
  installId: z.string().uuid(),
  mmagentVersion: VersionString,
  os: Os,
  nodeMajor: z.number().int().min(22).max(99),
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

  // R2: stage count must be > 0 for ok/incomplete (brief_too_vague may have 0)
  // R2.1: empty stages only allowed for brief_too_vague and error
  if (event.stages.length === 0 && !['brief_too_vague', 'error'].includes(event.terminalStatus)) {
    ctx.addIssue({ code: 'custom', message: 'R2.1: empty stages only allowed for brief_too_vague|error' });
  }

  // R3: concernCount must not exceed the sum of findingsBySeverity bins + a tolerance
  // Per plan Task 6, concernCount is capped separately; the invariant is sum(bins) ≤ concernCount

  // R4: totalDurationMs >= sum of stage durationMs (not strictly equal due to overhead)
  const stageDurationSum = event.stages.reduce((s, st) => s + st.durationMs, 0);
  if (stageDurationSum > event.totalDurationMs) {
    ctx.addIssue({ code: 'custom', message: 'R4: sum of stage durationMs must not exceed totalDurationMs' });
  }

  // R5: top-level token counts = sum of stage token counts
  const tokenSum = event.stages.reduce(
    (acc, st) => ({
      input: acc.input + st.inputTokens,
      output: acc.output + st.outputTokens,
      cached: acc.cached + st.cachedTokens,
      reasoning: acc.reasoning + st.reasoningTokens,
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0 },
  );
  if (
    tokenSum.input !== event.inputTokens ||
    tokenSum.output !== event.outputTokens ||
    tokenSum.cached !== event.cachedTokens ||
    tokenSum.reasoning !== event.reasoningTokens
  ) {
    ctx.addIssue({ code: 'custom', message: 'R5: token sums must equal top-level totals' });
  }

  // R5b: per stage, reasoningTokens ≤ outputTokens (subset semantics)
  for (const st of event.stages) {
    if (st.reasoningTokens > st.outputTokens) {
      ctx.addIssue({ code: 'custom', message: 'R5b: reasoningTokens must not exceed outputTokens per stage' });
    }
  }

  // R6: per stage, cachedTokens ≤ inputTokens (cached is subset of input)
  for (const st of event.stages) {
    if (st.cachedTokens > st.inputTokens) {
      ctx.addIssue({ code: 'custom', message: 'R6: cachedTokens must not exceed inputTokens per stage' });
    }
  }

  // R7: totalCostUSD = sum of stage costUSD (float comparison with tolerance)
  const costSum = event.stages.reduce((s, st) => s + st.costUSD, 0);
  if (Math.abs(costSum - event.totalCostUSD) > 0.02) {
    ctx.addIssue({ code: 'custom', message: 'R7: totalCostUSD must approximately equal sum of stage costUSD' });
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

  // R14: totalCostUSD in [0, 800], totalSavedCostUSD in [-800, 800] or null
  // (enforced by Zod schema bounds)

  // R15: costUSD per stage in [0, 100]
  // (enforced by Zod schema bounds)
});

// ── Inferred TS types ────────────────────────────────────────────────────

export type BatchWrapper = z.infer<typeof BatchWrapperSchema>;
export type StageEntryType = z.infer<typeof StageEntrySchema>;
export type TaskCompletedEventType = z.infer<typeof TaskCompletedEventSchema>;
export type UploadBatchType = z.infer<typeof UploadBatchSchema>;
export type ConcernCategoryType = z.infer<typeof ConcernCategory>;
export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type FindingsBySeverity = z.infer<typeof FindingsBySeveritySchema>;
