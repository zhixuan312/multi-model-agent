import type { Input } from './schema.js';
import type { ReviewPolicy } from '../../../types/review-policy.js';
import {
  JOURNAL_RECORD_ORIENTATION, JOURNAL_RECORD_PROCEDURE, JOURNAL_RECORD_EDGE_VOCAB,
  JOURNAL_RECORD_REPORT, JOURNAL_RECORD_UNTRUSTED,
} from './implementer-criteria.js';

export interface JournalRecordBrief {
  prompt: string;
  /** Clean subject source for the deterministic commit (compose-commit-message). */
  taskDescriptor: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: ReviewPolicy;
  contextBlockIds?: string[];
}

function compile(learnings: string[], tagHints?: string[]): string {
  const hints = tagHints && tagHints.length
    ? `\n\nTag hints (batch-scoped — apply across all learnings; revise/normalize per node): ${tagHints.join(', ')}.`
    : '';
  const numbered = learnings.map((l, i) => `LEARNING ${i + 1} (learningIndex ${i}):\n${l}`).join('\n\n');
  return [
    JOURNAL_RECORD_ORIENTATION, '',
    'The learnings to record (the contract) — integrate EACH one IN ORDER:', '',
    numbered, hints, '',
    JOURNAL_RECORD_PROCEDURE, '', JOURNAL_RECORD_EDGE_VOCAB, '',
    JOURNAL_RECORD_UNTRUSTED, '', JOURNAL_RECORD_REPORT,
  ].join('\n');
}

export const journalRecordBriefSlot = (input: Input): JournalRecordBrief[] => [{
  prompt: compile(input.learnings, input.tagHints),
  taskDescriptor: input.learnings.length === 1
    ? `record learning: ${input.learnings[0]}`
    : `record ${input.learnings.length} learnings`,
  agentType: 'complex',
  reviewPolicy: 'full',
  contextBlockIds: input.contextBlockIds,
}];
