import type { Input } from './schema.js';
import type { TaskInput } from '../../../lifecycle/goal-builder.js';
import { firstLine } from '../../../lifecycle/goal-prompts.js';
import {
  JOURNAL_RECORD_ORIENTATION, JOURNAL_RECORD_PROCEDURE, JOURNAL_RECORD_EDGE_VOCAB,
  JOURNAL_RECORD_REPORT, JOURNAL_RECORD_UNTRUSTED,
} from './implementer-criteria.js';

/**
 * One goal-set per /journal-record call. Each learning becomes one GoalTask;
 * the journal integration procedure rides as the goal preamble (prepended to
 * both phase prompts). Both phases run on the complex tier — journal dedup /
 * refine / supersede is nuanced enough to warrant it on the write phase too.
 */
export interface JournalRecordBrief {
  tasks: TaskInput[];
  preamble: string;
  contextBlockIds?: string[];
}

/** The shared journal procedure, carried as the goal preamble. */
function journalPreamble(tagHints?: string[]): string {
  const hints = tagHints && tagHints.length
    ? `\n\nTag hints (batch-scoped — apply across all learnings; revise/normalize per node): ${tagHints.join(', ')}.`
    : '';
  return [
    JOURNAL_RECORD_ORIENTATION,
    hints,
    '',
    JOURNAL_RECORD_PROCEDURE, '', JOURNAL_RECORD_EDGE_VOCAB, '',
    JOURNAL_RECORD_UNTRUSTED, '', JOURNAL_RECORD_REPORT,
  ].join('\n');
}

export const journalRecordBriefSlot = (input: Input): JournalRecordBrief[] => {
  const tasks: TaskInput[] = input.learnings.map((l, i) => ({
    heading: `learning ${i + 1}: ${firstLine(l)}`,
    body: l,
    phase: 1,
  }));
  return [{
    tasks,
    preamble: journalPreamble(input.tagHints),
    contextBlockIds: input.contextBlockIds,
  }];
};
