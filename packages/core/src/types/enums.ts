import { z } from 'zod';

export type FindingsOutcome = 'found' | 'clean' | 'not_applicable';

export const ConcernCategory = z.enum([
  'missing_test', 'scope_creep', 'incomplete_impl', 'style_lint', 'security',
  'performance', 'maintainability', 'doc_gap', 'doc_drift', 'contract_violation',
  'coverage_gap', 'dead_code', 'queue_hygiene', 'other',
]);

export type ConcernCategoryType = z.infer<typeof ConcernCategory>;
