import type { ReadOnlySubtypeSpec } from '../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../read-route-prompt.js';
import {
  DEBUG_PURPOSE_ORIENTATION, EVIDENCE_RULE_DEBUG, SCOPE_RULE_DEBUG,
  ANNOTATOR_AWARENESS_DEBUG, DEBUG_CRITERIA,
} from './implementer-criteria.js';

export type DebugSubtype = 'default';

// Copied verbatim from ROUTE_SEMANTICS.debug.
const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Apply THIS failure mode as the lens. Each finding is a root-cause hypothesis (or contributing factor), framed against this lens; severity = strength of the evidence chain.',
  emptyOutcomeLine: 'If THIS lens reveals nothing in the failure under investigation, respond with "No findings for this criterion." — valid outcome.',
  findingMeaningParagraph: 'A finding is a ROOT-CAUSE HYPOTHESIS (or contributing factor) for the failure under investigation, viewed through this criterion\'s lens. Title = the proposed cause. Severity reflects how strong the trace from symptom to cause is.',
  severityMeanings: {
    critical: 'Confirmed root cause',
    high: 'Very likely root cause; one step unconfirmed',
    medium: 'Plausible hypothesis',
    low: 'Peripheral observation',
  },
  mustEmitAtLeastOne: true,
  legalOutcomes: ['found', 'not_applicable'] as const,
};

export const DEBUG_SUBTYPES: Record<DebugSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: DEBUG_CRITERIA,
    orientation: DEBUG_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_DEBUG,
    scopeRule: SCOPE_RULE_DEBUG,
    annotatorAwareness: ANNOTATOR_AWARENESS_DEBUG,
    semantics: SEMANTICS_DEFAULT,
  },
};
