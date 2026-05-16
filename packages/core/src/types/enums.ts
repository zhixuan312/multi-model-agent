// Closed Zod enums — canonical home for the closed-enum ratchet.
//
// Per architecture.md:209 ("types/enums.ts — mirrors enums.md (Zod
// schemas)"), this file is the single source of truth for the Zod
// representation of every closed enum in `docs/superpowers/specs/0.4.0/enums.md`.
// Add new enums here, not at the consumer site. Other modules (events,
// review, error-codes) re-export from here for proximity but never
// re-declare.
//
// Ordering follows enums.md sections:
//   §1 Identity & routing       — TierEnum, RouteEnum, ProviderTypeEnum
//   §2 Tool surface             — (toolMode + reviewPolicy are TS string
//                                   literal types in types/task-spec.ts)
//   §3 Verdicts & status        — InternalRunStatusEnum, ReviewVerdictEnum,
//                                  WorkerStatusEnum, VerifyOutcomeEnum,
//                                  VerifySkipReasonEnum
//   §4 Errors                   — ErrorCodeSchema (lives in error-codes.ts
//                                   next to retryableFor; not re-imported here
//                                   to avoid a cycle with that helper module)
//   §5 Findings                 — ConcernCategory; severity is a TS literal
//   §6 Confidence               — InvestigationConfidenceEnum, FindingConfidenceSchema
//   §7 Events                   — EventTypeEnum
//   §8 Capabilities             — (modeled as TS literals on AgentConfig)
//   §9 Tool category            — ('toolCategory' is a TS literal on
//                                   ToolSurfaceRegistry; not Zod)
//   §10 Review engine           — ReviewEngineTypeEnum
//   §11 Research substrate      — ResearchAdapterEnum
//   §12 Diagnostics             — IncompleteReasonEnum, EvidenceKindEnum
//   §13 Diagnostic discriminators — DiagLoopEnum, DiagRoleEnum, DiagReasonEnum

import { z } from 'zod';

// ── §1 Identity & routing ─────────────────────────────────────────────────

export const TierEnum = z.enum(['standard', 'complex']);

export const RouteEnum = z.enum([
  'delegate', 'audit', 'review', 'debug', 'execute-plan', 'retry',
  'investigate',
  'register-context-block',
  'research',
]);

export const ProviderTypeEnum = z.enum(['claude', 'codex']);

// ── §3 Verdicts & status ──────────────────────────────────────────────────

export const InternalRunStatusEnum = z.enum([
  'ok', 'incomplete', 'timeout', 'api_aborted', 'api_error',
  'provider_transport_failure', 'error', 'brief_too_vague', 'cost_exceeded', 'unavailable',
]);

export const ReviewVerdictEnum = z.enum([
  'approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable',
]);

export const VerifyOutcomeEnum = z.enum(['passed', 'failed', 'skipped', 'not_applicable', 'transformed']);

export const VerifySkipReasonEnum = z.enum([
  'no_command', 'dirty_worktree', 'not_applicable', 'other',
]);

export const WorkerStatusEnum = z.enum([
  'done', 'done_with_concerns', 'needs_context', 'blocked',
  'review_loop_capped', 'failed',
]);

// ── §5 Findings ───────────────────────────────────────────────────────────

export const ConcernCategory = z.enum([
  'missing_test',
  'scope_creep',
  'incomplete_impl',
  'style_lint',
  'security',
  'performance',
  'maintainability',
  'doc_gap',
  'doc_drift',
  'contract_violation',
  'coverage_gap',
  'dead_code',
  'queue_hygiene',
  'other',
]);

export type ConcernCategoryType = z.infer<typeof ConcernCategory>;

// ── §6 Confidence ─────────────────────────────────────────────────────────

export const InvestigationConfidenceEnum = z.enum(['low', 'medium', 'high']);
export const FindingConfidenceSchema = z.number().int().min(0).max(100);

// ── §7 Events ─────────────────────────────────────────────────────────────

// Wire-event discriminator. Inventory derived from observability-events.ts.
// Spec enums.md §7 enumerates these same 31 names — see that section if you
// need the phase grouping. New event kinds add here AND in the spec §7 table.
export const EventTypeEnum = z.enum([
  'batch_completed','batch_failed','escalation','escalation_unavailable',
  'fallback','fallback_unavailable',
  'heartbeat','read_only_review.quality','read_only_review.terminal','review_decision',
  'stage_change','stall_abort','task_completed','task_started','text_emission',
  'time_check','tool_call','turn_complete','turn_start','verify_skipped','verify_step','worker_start',
]);

// ── §10 Review engine ─────────────────────────────────────────────────────

export const ReviewEngineTypeEnum = z.enum(['reviewer', 'annotator']);

// ── §11 Research substrate ────────────────────────────────────────────────

// Per spec enums.md §11: 6 research adapters. The four named adapters
// (arxiv, semantic_scholar, github_search, rss) wrap content-source
// parsing; web_search is Brave-backed; web_fetch is the generic
// hardened HTTPS GET (research/web-search.ts and research/web-fetch.ts).
export const ResearchAdapterEnum = z.enum([
  'arxiv', 'semantic_scholar', 'github_search', 'rss', 'web_search', 'web_fetch',
]);

// ── §12 Diagnostics ───────────────────────────────────────────────────────

export const IncompleteReasonEnum = z.enum(['turn_cap', 'cost_cap', 'timeout', 'missing_sections']);

/**
 * Forward-declared per spec enums.md §12. Consumed when the debug-report
 * shape is widened to include an evidenceTrail (separate v4.x feature).
 * Defined here so the closed-enum ratchet covers it before adoption.
 */
export const EvidenceKindEnum = z.enum(['reproducer', 'code_path', 'fix']);

// ── §13 Diagnostic discriminators ─────────────────────────────────────────

export const DiagLoopEnum = z.enum(['spec', 'quality', 'diff']);

export const DiagRoleEnum = z.enum([
  'implementer', 'specReviewer', 'qualityReviewer', 'diffReviewer',
]);

export const DiagReasonEnum = z.enum(['transport_failure', 'not_configured']);
