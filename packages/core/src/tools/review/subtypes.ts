import type { ReadOnlySubtypeSpec } from '../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';
import {
  REVIEW_PURPOSE_ORIENTATION, EVIDENCE_RULE_REVIEW, SCOPE_RULE_REVIEW,
  ANNOTATOR_AWARENESS_REVIEW, REVIEW_CRITERIA,
} from './implementer-criteria.js';

export type ReviewSubtype = 'default';

// Copied verbatim from ROUTE_SEMANTICS.review in
// packages/core/src/lifecycle/parallel-criteria-routes.ts (removed in Task 8).
const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Find ALL issues of THIS specific kind in the diff / source above.',
  emptyOutcomeLine: 'If none exist, respond with the literal text "No findings for this criterion." — that is a fully valid outcome. Do NOT pad to avoid returning empty.',
  findingMeaningParagraph: 'A finding is an ISSUE introduced or worsened by the change under review (correctness bug, missing test, race, security regression, contract break, etc.). Severity reflects how much the issue blocks merge / ships a regression.',
  severityMeanings: {
    critical: 'security regression / data corruption / build-breaking change — must NOT merge.',
    high: 'real correctness bug, broken tests, race, missing edge case that ships a regression — blocks release.',
    medium: 'contract violation, maintainability issue, doc gap, deprecated API, performance regression on a non-hot path — fix soon, not blocking.',
    low: 'style, naming, comment nit, dead code — nice-to-fix.',
  },
  mustEmitAtLeastOne: false,
};

export const REVIEW_SUBTYPES: Record<ReviewSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: REVIEW_CRITERIA,
    orientation: REVIEW_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_REVIEW,
    scopeRule: SCOPE_RULE_REVIEW,
    annotatorAwareness: ANNOTATOR_AWARENESS_REVIEW,
    semantics: SEMANTICS_DEFAULT,
  },
};
