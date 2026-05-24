import type { Input } from './schema.js';
import type { ReviewPolicy } from '../../../types/review-policy.js';
import {
  JOURNAL_RECORD_ORIENTATION, JOURNAL_RECORD_PROCEDURE, JOURNAL_RECORD_EDGE_VOCAB,
  JOURNAL_RECORD_REPORT, JOURNAL_RECORD_UNTRUSTED,
} from './implementer-criteria.js';

export interface JournalRecordBrief {
  prompt: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: ReviewPolicy;
  contextBlockIds?: string[];
}

function compile(learning: string, tagHints?: string[]): string {
  const hints = tagHints && tagHints.length ? `\n\nTag hints (revise/normalize as needed): ${tagHints.join(', ')}.` : '';
  return [
    JOURNAL_RECORD_ORIENTATION, '',
    'The learning to record (the contract):', '', learning, hints, '',
    JOURNAL_RECORD_PROCEDURE, '', JOURNAL_RECORD_EDGE_VOCAB, '',
    JOURNAL_RECORD_UNTRUSTED, '', JOURNAL_RECORD_REPORT,
  ].join('\n');
}

export const journalRecordBriefSlot = (input: Input): JournalRecordBrief[] => [{
  prompt: compile(input.learning, input.tagHints),
  agentType: 'complex',
  reviewPolicy: 'full',
  contextBlockIds: input.contextBlockIds,
}];
