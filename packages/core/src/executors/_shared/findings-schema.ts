import { z } from 'zod';

/**
 * Single finding shape for the 5 read-only routes (audit / review / verify /
 * debug / investigate).
 *
 * Produced by the quality-review stage in one pass. The reviewer reads the
 * implementer's free-form markdown narrative, extracts each distinct issue,
 * normalizes severity to one of {critical, high, medium, low}, and scores it.
 *
 * Field semantics:
 * - id: reviewer-assigned, unique within the array. Convention: F1, F2, F3, ...
 * - severity: 4-tier {critical, high, medium, low}. Use 'critical' for issues
 *   that must be fixed before any other work (RCE, auth bypass, data loss).
 *   Use 'high' for serious bugs / security issues that block release.
 * - claim: one-sentence summary of what is wrong / what is true.
 * - evidence: REQUIRED, ≥20 chars. SHOULD be a verbatim quote from the
 *   implementer's worker output. The parser sets `evidenceGrounded: true`
 *   when the quote (whitespace-normalized) appears as a substring of the
 *   worker output, false otherwise. Findings are never DROPPED for
 *   ungrounded evidence — the field is a soft trust signal for the main agent.
 * - suggestion: optional. For investigate, may be a follow-up question.
 * - annotatorConfidence: integer 0–100 in the normal annotation path. NULL
 *   in the deterministic fallback path (regex-extracted findings — no LLM
 *   confidence available).
 * - evidenceGrounded: parser-assigned. True when evidence is a substring
 *   of worker output (whitespace-normalized), false otherwise.
 */
export const annotatedFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  claim: z.string().min(1),
  evidence: z.string().min(20),
  suggestion: z.string().optional(),
  annotatorConfidence: z.number().int().min(0).max(100).nullable(),
  evidenceGrounded: z.boolean(),
}).strict();

export const annotatedFindingsSchema = z.array(annotatedFindingSchema).refine(
  (arr) => new Set(arr.map(f => f.id)).size === arr.length,
  { message: 'duplicate finding id within array' },
);

export type AnnotatedFinding = z.infer<typeof annotatedFindingSchema>;

/**
 * Reviewer-emitted shape BEFORE the parser annotates `evidenceGrounded`.
 * Reviewer prompts instruct emission of these fields; the parser adds the
 * grounded flag.
 */
export const reviewerEmittedFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  claim: z.string().min(1),
  evidence: z.string().min(20),
  suggestion: z.string().optional(),
  annotatorConfidence: z.number().int().min(0).max(100),
}).strict();

export const reviewerEmittedFindingsSchema = z.array(reviewerEmittedFindingSchema).refine(
  (arr) => new Set(arr.map(f => f.id)).size === arr.length,
  { message: 'duplicate finding id within array' },
);

export type ReviewerEmittedFinding = z.infer<typeof reviewerEmittedFindingSchema>;

/** Whitespace-normalize: collapse runs of whitespace, trim. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Returns true when `evidence` (whitespace-normalized) appears as a substring
 * of `workerOutput` (whitespace-normalized) AND is at least 20 chars.
 *
 * Intentionally case-sensitive (Round-2 finding #7): the grounding check is
 * a strict "verbatim quote" verification. Reviewers that paraphrase, change
 * case, or substitute smart-quotes will see `evidenceGrounded: false` for
 * those findings — a soft signal that the main agent renders as "lower
 * trust" but never drops. If we ever want fuzzy matching, do it in a
 * separate helper to keep the strict path obvious.
 */
export function evidenceIsGrounded(evidence: string, workerOutput: string): boolean {
  const e = normalizeWhitespace(evidence);
  if (e.length < 20) return false;
  return normalizeWhitespace(workerOutput).includes(e);
}
