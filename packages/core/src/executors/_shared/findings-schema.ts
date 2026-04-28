import { z } from 'zod';

/**
 * Finding shape emitted by all 5 read-only mma-* workers, then annotated by
 * the quality-review stage with reviewer fields.
 *
 * Two phases:
 * - WorkerFinding: what the worker emits (no reviewer fields).
 * - AnnotatedFinding: WorkerFinding + reviewer-added confidence and optional
 *   severity-correction. This is what ends up in the executor envelope.
 *
 * - severity: lowercase to match RunResult.concerns[].severity.
 * - evidence: required, ≥20 chars. Embed file:line as prose plus a one-sentence
 *   explanation of what the cited code shows. Forces grounding so reviewer
 *   confidence is meaningful.
 * - suggestion: optional. For investigate, may be a follow-up question rather
 *   than a code fix.
 * - reviewerConfidence: integer 0-100. Reviewer's confidence that the finding
 *   is correct, on-brief, and well-grounded in the worker's evidence.
 * - reviewerSeverity: only present when the reviewer disagrees with the
 *   worker's severity (workers tend to inflate; reviewer can dial down).
 */
export const workerFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
  claim: z.string().min(1),
  evidence: z.string().min(20),
  suggestion: z.string().optional(),
}).strict();

export const workerFindingsSchema = z.array(workerFindingSchema).refine(
  (arr) => new Set(arr.map(f => f.id)).size === arr.length,
  { message: 'duplicate finding id within array' },
);

export const annotatedFindingSchema = workerFindingSchema.extend({
  reviewerConfidence: z.number().int().min(0).max(100),
  reviewerSeverity: z.enum(['high', 'medium', 'low']).optional(),
}).strict();

export const annotatedFindingsSchema = z.array(annotatedFindingSchema);

export type WorkerFinding = z.infer<typeof workerFindingSchema>;
export type AnnotatedFinding = z.infer<typeof annotatedFindingSchema>;
