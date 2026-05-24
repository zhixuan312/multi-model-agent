import type { ReadOnlySubtypeSpec } from '../../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../../read-route-prompt.js';
import {
  JOURNAL_RECALL_ORIENTATION, JOURNAL_RECALL_PROCEDURE, JOURNAL_RECALL_SEVERITY,
  JOURNAL_RECALL_UNTRUSTED, JOURNAL_RECALL_EMPTY,
} from './implementer-criteria.js';

export type JournalRecallSubtype = 'default';

const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Answer the user\'s conceptual question. Each finding is a RELEVANT prior learning from the project\'s journal, presented with its context and relationships.',
  emptyOutcomeLine: 'If the journal is empty or nothing is relevant, respond plainly with that finding.',
  findingMeaningParagraph: 'A finding is a relevant prior learning from the journal (a node that answers or contextualizes the query). Title = the learning in one line. Issue = the learning with citations to node IDs. Severity = relevance to the query.',
  severityMeanings: {
    critical: 'Directly answers the query',
    high: 'Changes the recommendation',
    medium: 'Provides contextual support',
    low: 'Historical or peripheral context',
  },
  mustEmitAtLeastOne: false,
  legalOutcomes: ['found', 'not_applicable'] as const,
};

export const JOURNAL_RECALL_SUBTYPES: Record<JournalRecallSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: [],
    orientation: JOURNAL_RECALL_ORIENTATION,
    evidenceRule: JOURNAL_RECALL_PROCEDURE,
    scopeRule: JOURNAL_RECALL_SEVERITY,
    annotatorAwareness: JOURNAL_RECALL_UNTRUSTED,
    semantics: SEMANTICS_DEFAULT,
  },
};
