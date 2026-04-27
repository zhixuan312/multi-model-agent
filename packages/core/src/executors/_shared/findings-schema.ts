import { z } from 'zod';

/**
 * Structured finding shape emitted by all 5 read-only mma-* workers.
 * Used by the quality-review stage to iterate per-finding judgments.
 *
 * - `severity` is lowercase to match RunResult.concerns[].severity.
 * - `file` and `line` are independently nullable: project-level findings
 *   have both null; multi-line findings keep `line` pointing at the start
 *   of the cited region and use `sourceQuote` for the full text.
 * - `line` is 1-indexed (editor convention).
 * - `sourceQuote` and `suggestedFix` are optional.
 */
export const findingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
  file: z.string().nullable(),
  line: z.number().int().min(1).nullable(),
  claim: z.string().min(1),
  sourceQuote: z.string().optional(),
  suggestedFix: z.string().optional(),
});

export const findingsSchema = z.array(findingSchema);

export type Finding = z.infer<typeof findingSchema>;
