import { z } from 'zod';

const findingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.string().min(1),
  description: z.string().min(1),
  location: z.string().min(1),
  fix: z.enum(['applied', 'suggested']),
});

const reviewerOutputSchema = z.object({
  findings: z.array(findingSchema),
  summary: z.string().min(1),
  verdict: z.enum(['approved', 'changes_made']),
});

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type ReviewerFinding = z.infer<typeof findingSchema>;
export type ParseResult = { ok: true; data: ReviewerOutput } | { ok: false; error: string; raw: string };

export function parseReviewerOutput(raw: string): ParseResult {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'No JSON found in reviewer output', raw };

  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return { ok: false, error: 'Invalid JSON in reviewer output', raw }; }

  const result = reviewerOutputSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: `Schema: ${result.error.message}`, raw };

  return { ok: true, data: result.data };
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) return fenced[1]!.trim();
  const bare = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (bare) return bare[0]!.trim();
  return null;
}
