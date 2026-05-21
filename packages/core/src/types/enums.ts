// Closed Zod enums still consumed at runtime.
//
// Only the enums with live consumers remain: ReviewVerdictEnum (terminal
// output schema, tools/shared-output.ts) and ConcernCategory + its inferred
// ConcernCategoryType (wire telemetry, events/wire-schema.ts). The earlier
// spec-mirroring set of closed enums was removed once it had no consumers;
// re-add an enum here when a feature actually wires it.

import { z } from 'zod';

export const ReviewVerdictEnum = z.enum([
  'approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable',
]);

export const ConcernCategory = z.enum([
  'missing_test', 'scope_creep', 'incomplete_impl', 'style_lint', 'security',
  'performance', 'maintainability', 'doc_gap', 'doc_drift', 'contract_violation',
  'coverage_gap', 'dead_code', 'queue_hygiene', 'other',
]);

export type ConcernCategoryType = z.infer<typeof ConcernCategory>;
