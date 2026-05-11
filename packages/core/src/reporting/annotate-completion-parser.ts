import { z } from 'zod';

/**
 * Annotator JSON output schema (pipeline-redesign §3.3.4).
 *
 * The annotator emits structured JSON inside a ```json fenced block.
 * This module extracts + validates the block. The `verify` slot is NOT
 * emitted by the annotator — it's overlaid by the annotate-completion
 * handler after parsing, using the deterministic verify-command result.
 */
const annotatorOutputSchema = z.object({
  completionPercent: z.number().int().min(0).max(100),
  perStep: z.array(z.object({
    step: z.string(),
    status: z.enum(['done', 'partial', 'missing']),
    note: z.string().nullable(),
  })),
  concerns: z.array(z.string()),
});

export type AnnotatorOutput = z.infer<typeof annotatorOutputSchema>;

export type ParseResult =
  | { ok: true; value: AnnotatorOutput }
  | { ok: false; error: string };

/**
 * Extract the FIRST ```json fenced block from the annotator's LLM output
 * and validate against `annotatorOutputSchema`. Returns the parsed value
 * on success; a structured error string on failure (the caller may retry
 * once with a stricter prompt, then fall back per §3.3.5).
 */
export function parseAnnotatorOutput(raw: string): ParseResult {
  const match = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) {
    return { ok: false, error: 'no ```json fenced block found in annotator output' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = annotatorOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `schema validation failed: ${JSON.stringify(result.error.issues)}` };
  }
  return { ok: true, value: result.data };
}
