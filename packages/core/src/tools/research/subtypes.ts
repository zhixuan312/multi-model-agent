import type { ReadOnlySubtypeSpec } from '../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';
import {
  RESEARCH_CRITERIA, RESEARCH_PURPOSE_ORIENTATION, EVIDENCE_RULE_RESEARCH_COMPOSED,
  SCOPE_RULE_RESEARCH, ANNOTATOR_AWARENESS_RESEARCH,
} from './implementer-criteria.js';

export type ResearchSubtype = 'default';

const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Apply THIS perspective to the user\'s research question. Each finding is a candidate insight from one cited external source.',
  emptyOutcomeLine: 'If you can produce no candidate insight at all under this lens, respond with "No findings for this criterion." — valid but rare; in most cases you can produce at least one source-cited candidate.',
  findingMeaningParagraph: 'A finding is a CANDIDATE INSIGHT from ONE cited external source, viewed through this criterion\'s lens. Title = the insight in one line. Issue = the insight + reasoning + source citation. Severity = strength of evidence chain.',
  severityMeanings: {
    critical: 'Primary authoritative source',
    high: 'Strong secondary source',
    medium: 'Tertiary source',
    low: 'Inferred/synthesized',
  },
  mustEmitAtLeastOne: true,
  legalOutcomes: ['found', 'not_applicable'] as const,
};

export const RESEARCH_SUBTYPES: Record<ResearchSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: RESEARCH_CRITERIA,
    orientation: RESEARCH_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_RESEARCH_COMPOSED,
    scopeRule: SCOPE_RULE_RESEARCH,
    annotatorAwareness: ANNOTATOR_AWARENESS_RESEARCH,
    semantics: SEMANTICS_DEFAULT,
  },
};
