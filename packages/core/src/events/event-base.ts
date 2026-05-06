import { z } from 'zod';

// Shared enums and base schemas used across observability-events.ts,
// cloud-events.ts, and any future event family file. Kept in its own
// module so siblings can import without circularity.

/** Shared base for task-level events (has taskIndex). */
export const TaskBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
  taskIndex: z.number().int().min(0),
});

/** Shared base for batch-level events (no taskIndex). */
export const BatchBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
});

export const RouteEnum = z.enum([
  'delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'retry',
  'investigate', 'explore',
  'explore_internal', 'explore_external', 'explore_synthesize',
  'register-context-block',
]);

export const TierEnum = z.enum(['standard', 'complex']);

export const DiagLoopEnum = z.enum(['spec', 'quality', 'diff']);

export const DiagRoleEnum = z.enum([
  'implementer', 'specReviewer', 'qualityReviewer', 'diffReviewer',
]);

export const DiagReasonEnum = z.enum(['transport_failure', 'not_configured', 'reviewer_separation_unsatisfiable']);

export const ProviderTypeEnum = z.enum(['claude', 'claude-compatible', 'openai-compatible', 'codex']);

export const RunStatusEnum = z.enum([
  'ok', 'incomplete', 'timeout', 'api_aborted', 'api_error',
  'provider_transport_failure', 'error', 'brief_too_vague', 'cost_exceeded', 'unavailable',
]);

export const ReviewVerdictEnum = z.enum([
  'approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable',
]);

export const VerifyOutcomeEnum = z.enum(['passed', 'failed', 'skipped', 'not_applicable']);

export const VerifySkipReasonEnum = z.enum([
  'no_command', 'dirty_worktree', 'not_applicable', 'other',
]);

export const WorkerStatusEnum = z.enum([
  'done', 'done_with_concerns', 'needs_context', 'blocked',
  'review_loop_capped', 'failed',
]);

export const ReviewEngineTypeEnum = z.enum(['reviewer', 'annotator']);

/**
 * Forward-declared per spec enums.md §5. Consumed when the debug-report
 * shape is widened to include an evidenceTrail (separate v4.x feature).
 * Defined here so the closed-enum ratchet covers it before adoption.
 */
export const EvidenceKindEnum = z.enum(['reproducer', 'code_path', 'fix']);
