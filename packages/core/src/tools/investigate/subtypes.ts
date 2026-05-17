import type { ReadOnlySubtypeSpec } from '../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';
import {
  INVESTIGATE_PURPOSE_ORIENTATION, EVIDENCE_RULE_INVESTIGATE, SCOPE_RULE_INVESTIGATE,
  ANNOTATOR_AWARENESS_INVESTIGATE, INVESTIGATE_CRITERIA,
} from './implementer-criteria.js';

export type InvestigateSubtype = 'default';

// Copied verbatim from ROUTE_SEMANTICS.investigate.
const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Answer the user\'s question above. Each finding is a CANDIDATE ANSWER (or sub-answer / partial answer) to the question, presented through this criterion\'s lens. Pay extra care to AVOID this criterion\'s failure mode (it is a known way investigators go wrong on questions like this).',
  emptyOutcomeLine: 'If you can produce no candidate answer at all under this lens, respond with "No findings for this criterion." — valid but rare outcome. In most cases you can produce at least one low-confidence candidate answer.',
  findingMeaningParagraph: 'A finding is a CANDIDATE ANSWER to the user\'s question (or a sub-answer that contributes to the full answer). Title = the answer in one line. Issue = the answer with reasoning + citations. Severity = your confidence in this answer.',
  severityMeanings: {
    critical: 'Direct verbatim citation',
    high: 'Clearly inferable from cited source',
    medium: 'Single interpretation step required',
    low: 'Weak inference',
  },
  mustEmitAtLeastOne: true,
  legalOutcomes: ['found', 'not_applicable'] as const,
};

export const INVESTIGATE_SUBTYPES: Record<InvestigateSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: INVESTIGATE_CRITERIA,
    orientation: INVESTIGATE_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_INVESTIGATE,
    scopeRule: SCOPE_RULE_INVESTIGATE,
    annotatorAwareness: ANNOTATOR_AWARENESS_INVESTIGATE,
    semantics: SEMANTICS_DEFAULT,
  },
};
