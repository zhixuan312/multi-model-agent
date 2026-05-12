import type { CriterionEntry } from '../tools/criteria-types.js';
import type { RouteSemantics } from '../tools/parallel-criteria-prompt.js';

/**
 * One subtype's full prompt-policy package. Five read-only tools each own
 * a `SUBTYPES: Record<Subtype, ReadOnlySubtypeSpec>` map (see
 * `packages/core/src/tools/<tool>/subtypes.ts`). Adding a subtype = one new
 * entry in the tool's `SUBTYPES` map plus the matching enum literal in the
 * tool's input schema. No new HTTP route or handler.
 */
export interface ReadOnlySubtypeSpec {
  criteria: readonly CriterionEntry[];
  orientation: string;
  evidenceRule: string;
  scopeRule: string;
  annotatorAwareness: string;
  semantics: RouteSemantics;
}
