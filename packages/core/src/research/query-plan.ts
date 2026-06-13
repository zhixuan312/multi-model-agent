import { z } from 'zod';

const Query200 = z.string().min(1).max(200);
const Queries = z.array(Query200).max(8);

const BraveQuery = z.object({
  q:          Query200,
  freshness:  z.union([
    z.enum(['pd', 'pw', 'pm', 'py']),
    z.string().regex(/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/),
  ]).optional(),
  endpoint:   z.enum(['web', 'news']).default('web'),
  siteFilter: z.string().max(100).optional(),
});

export const QueryPlanSchema = z.object({
  braveQueries:           z.array(BraveQuery).max(8),
  arxivQueries:           Queries,
  semanticScholarQueries: Queries,
  githubQueries:          z.array(z.object({
    q:    Query200,
    kind: z.enum(['repo', 'code']),
  })).max(8),
  openalexQueries:        Queries.default([]),
  crossrefQueries:        Queries.default([]),
  pubmedQueries:          Queries.default([]),
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
