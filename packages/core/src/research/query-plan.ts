// Zod schema for the structured output the worker emits in turn 1.
// Bounds: 0..8 entries per query list, ≤ 200 chars per query.
import { z } from 'zod';

const Query200 = z.string().min(1).max(200);
const Queries = z.array(Query200).max(8);

export const QueryPlanSchema = z.object({
  braveQueries:           Queries,
  arxivQueries:           Queries,
  semanticScholarQueries: Queries,
  githubQueries:          z.array(z.object({
    q:    Query200,
    kind: z.enum(['repo', 'code']),
  })).max(8),
}).strict();

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

export function parseQueryPlan(json: string): QueryPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`QueryPlan JSON parse failed: ${(e as Error).message}`);
  }
  const r = QueryPlanSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`QueryPlan schema validation failed: ${r.error.message}`);
  }
  return r.data;
}
