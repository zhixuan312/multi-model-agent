import { z } from 'zod';
import { ModelFamilyEnum } from '../config/model-profile-registry.js';

/**
 * v7 (6.10.0) — the honesty pass.
 *
 * v6 carried nine fields no component could produce: every one of them arrived
 * as a hardcoded 0 on every event since 4.8.0, when the lifecycle layer that
 * once measured them was deleted. A dashboard cannot tell a measured zero from
 * an unmeasured one, so those columns read as good news — "no stalls, no
 * sandbox violations, no escalations" — when the truth was "nobody looked".
 * They are gone rather than fixed, except `sandboxViolationCount`, which is now
 * really measured (and nullable where it cannot be).
 *
 * Removed: stallCount, taskMaxIdleMs, escalationCount, fallbackCount, subtype,
 * roundsUsed, outcomeInferred, outcomeMalformed, per-stage maxIdleMs/totalIdleMs,
 * and the rework/annotating/committing stage variants.
 * Changed: concernCategories is free text; sandboxViolationCount is nullable;
 * terminalStatus gained `cancelled` and now distinguishes timeout/unavailable.
 */
export const SCHEMA_VERSION = 7;

export const STRICT_ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9_.:+/@]{0,119}$/;

// ── Enums shared across stages and top-level ─────────────────────────────
//
// ConcernCategory lives at `types/enums.ts` per architecture.md:209;
// re-exported here so callers can pull it from the wire-schema module
// alongside the wire event types it is used in. The wire itself no longer
// validates against it — concernCategories carries the reviewer's own words.

export { ConcernCategory } from '../types/enums.js';

import { ErrorCodeSchema } from '../error-codes.js';
export const ErrorCode = ErrorCodeSchema;

export const FindingsBySeveritySchema = z.object({
  critical: z.number().int().min(0).max(200),
  high: z.number().int().min(0).max(200),
  medium: z.number().int().min(0).max(200),
  low: z.number().int().min(0).max(200),
}).strict();

// Shared base: matches the `TokenUsage` interface in `types/run-result.ts`, whose docstring
// carries the disjoint-partition contract every provider adapter normalizes to. (This said
// `runners/types.ts` — a path that does not exist in this layout and has not since the
// providers/ split.)
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

// The two stages the two-phase pipeline runs. `rework`, `annotating` and
// `committing` were also permitted; their producer was the lifecycle layer and
// went with it, so no event has carried one since 4.8.0.
const StageNameEnum = z.enum(['implementing', 'review']);

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
  // The reviewer's own words, not a closed enum. Validating against the 14-value
  // ConcernCategory flattened everything else to `other`, throwing the signal
  // away at the point it became specific — and a downstream store that rejects
  // an engine vocabulary it has not seen drops whole events (the `agentType:
  // 'main'` incident). Bounded in length and count, not in content.
  concernCategories: z.array(z.string().min(1).max(64)).max(16),
}).strict();

export const ImplementStageEntrySchema = StageEntryBase.extend({
  name: z.literal('implementing'),
}).strict();

export const StageEntrySchema = z.discriminatedUnion('name', [
  ImplementStageEntrySchema,
  ReviewStageEntrySchema,
]);

// ── Task completed event (§3.2) ──────────────────────────────────────────

export const TaskCompletedEventSchema = z.object({
  // Identity
  eventId: z.string().uuid(),
  route: z.enum(['delegate', 'audit', 'review', 'debug', 'execute-plan', 'investigate', 'research', 'journal-record', 'journal-recall', 'register-context-block', 'orchestrate', 'spec', 'plan']),
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

  // Tier-level usage breakdown (§3.2, §3.3).
  //
  // `main` was missing while `agentType` above has always allowed it and `orchestrate` runs on
  // that tier by default. Zod strips unknown keys, so `toWireRecord`'s own
  // `ValidatedTaskCompletedEventSchema.parse()` silently DELETED the main bucket the projection
  // had just built — every main-tier run reported `agentType: 'main'` with no usage under it.
  // The telemetry backend types `tierUsage` as an open record, so carrying the key costs it
  // nothing and its typed slot extraction simply ignores what it does not read.
  tierUsage: z.object({
    standard: TierUsageSchema.optional(),
    complex: TierUsageSchema.optional(),
    main: TierUsageSchema.optional(),
  }),

  // Outcome
  // `incomplete`, `brief_too_vague`, `needs_context`, `blocked` and
  // `review_loop_capped` were also permitted and nothing produced any of them —
  // retired lifecycle vocabulary. What IS produced: ok, error, and now
  // `timeout` (the run hit its wall clock), `unavailable` (the provider could
  // not be reached or authenticated — an infrastructure fact, not a task
  // outcome) and `cancelled` (the caller aborted it). Reporting all three as a
  // flat `error` is what made the failure rate unreadable: a run the user
  // cancelled counted against the engine exactly like a crash.
  terminalStatus: z.enum(['ok', 'timeout', 'error', 'unavailable', 'cancelled']),
  workerStatus: z.enum(['done', 'done_with_concerns', 'failed', 'cancelled']),
  // errorCode is non-null whenever terminalStatus === 'error'; `error-codes.ts` is the closed
  // vocabulary and anything outside it coerces to `other`.
  //
  // This used to name `review_diff_rejected`, `review_quality_findings_unresolved` and
  // `review_spec_rejected_terminal` as the reviewer-rejection codes. None of the three is in
  // `ErrorCodeSchema`, and nothing emits them — they are the removed lifecycle layer's
  // vocabulary, so the note described a distinction the wire could not carry.
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

  // Files changed — sourced from real git diff (sub-project A), not worker self-report.
  filesWrittenCount: z.number().int().min(0).max(5000),

  // Operational signals.
  //
  // Nullable, and the distinction is the point: 0 means the confinement hook
  // ran and refused nothing, null means this runner cannot observe a refusal at
  // all (codex confines writes in the OS sandbox). `stallCount` and
  // `taskMaxIdleMs` stood here reporting a hardcoded 0 on every event.
  sandboxViolationCount: z.number().int().min(0).max(1000).nullable(),

  // Stages array
  stages: z.array(StageEntrySchema).min(0).max(16),

  // Per-tool-call telemetry (AC-1.1), grouped and path-free: no file names or
  // contents ever reach the wire — only the (stage, turn, tool) cardinality.
  // Bounded generously above realistic per-task tool-call diversity.
  toolCalls: z.array(z.object({
    stage: z.string(),
    turn: z.number().int().min(1).max(250),
    tool: z.string(),
    count: z.number().int().min(1).max(10_000),
  })).max(500),

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
// A `review` stage is legitimate on every route that runs the two-phase pipeline — i.e. every route
// EXCEPT the two that never review: `orchestrate` (unified-task.ts forces reviewPolicy='none') and the
// `register-context-block` control op (no pipeline). Encode the COMPLEMENT so a newly-added task route
// is reviewable BY DEFAULT and does not silently drop its telemetry — the allowlist form twice omitted
// a reviewable route (journal-recall/research, then spec/plan).
const nonReviewedRoutes = new Set(['orchestrate', 'register-context-block']);

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

  // R2.1: a task with no stages did no LLM work, which is only legitimate when
  // it never got that far. `brief_too_vague` was in this list and is no longer a
  // terminalStatus; `unavailable` and `cancelled` join it because both can land
  // before the implementer produces a billable turn.
  if (event.stages.length === 0 && !['error', 'unavailable', 'cancelled'].includes(event.terminalStatus)) {
    ctx.addIssue({ code: 'custom', message: 'R2.1: empty stages only allowed for error|unavailable|cancelled' });
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
    if (st.name === 'review' && nonReviewedRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: 'R9: review stage only allowed on reviewed routes' });
    }
  }

  // R10c: annotated verdict only on quality_only routes
  for (const st of event.stages) {
    if ('verdict' in st && st.verdict === 'annotated' && !qualityOnlyRoutes.has(event.route)) {
      ctx.addIssue({ code: 'custom', message: 'R10c: annotated verdict only allowed on quality_only routes' });
    }
  }

  // R11/R12: concernCount and sandboxViolationCount bounds are enforced by the
  // Zod schema itself.

  // R13: totalDurationMs in [0, 86_400_000]
  // (enforced by Zod schema bounds)

  // R14: totalCostUSD in [0, 800] or null
  // (enforced by Zod schema bounds)

  // R16 required a `rework` stage to be accompanied by `review`. There is no
  // rework stage in v7 — the pipeline has exactly two phases.

  // R17: findings must agree with the severity histogram. These are two
  // projections of one list and nothing recomputed them from each other, so a
  // partial write could report 4 concerns and a histogram summing to 0 — the
  // exact ambiguity v7 exists to remove.
  if (event.findingsBySeverity) {
    const f = event.findingsBySeverity;
    const sum = f.critical + f.high + f.medium + f.low;
    if (sum !== event.concernCount) {
      ctx.addIssue({ code: 'custom', message: `R17: findingsBySeverity sums to ${sum} but concernCount is ${event.concernCount}` });
    }
  }

  // R18: `found` must come with findings, and `clean` must not. Without this a
  // route could report "clean" while carrying findings, and the dashboard would
  // show a reassuring badge over a list of problems.
  if (event.findingsOutcome === 'found' && event.concernCount === 0) {
    ctx.addIssue({ code: 'custom', message: 'R18: findingsOutcome=found requires concernCount > 0' });
  }
  if (event.findingsOutcome === 'clean' && event.concernCount > 0) {
    ctx.addIssue({ code: 'custom', message: 'R18: findingsOutcome=clean requires concernCount = 0' });
  }
});

// ── Inferred TS types ────────────────────────────────────────────────────

export type TaskCompletedEventType = z.infer<typeof TaskCompletedEventSchema>;
export type { ConcernCategoryType } from '../types/enums.js';
