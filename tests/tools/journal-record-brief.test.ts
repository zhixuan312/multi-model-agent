import { describe, it, expect } from 'vitest';
import { journalRecordBriefSlot } from '../../packages/core/src/tools/journal/record/brief-slot.js';

const L = (s: string) => s.padEnd(20, '.');

// Goal mode: one brief carrying the learnings as GoalTasks + the journal
// integration procedure as the goal `preamble` (prepended to both phase prompts).
describe('journal record brief', () => {
  it('produces exactly ONE brief regardless of learnings count (AC-10)', () => {
    expect(journalRecordBriefSlot({ learnings: [L('a'), L('b'), L('c')] })).toHaveLength(1);
  });
  it('makes one GoalTask per learning, embedding each learning body', () => {
    const b = journalRecordBriefSlot({ learnings: [L('alpha-lesson'), L('beta-lesson')] })[0]!;
    expect(b.tasks).toHaveLength(2);
    expect(b.tasks[0]!.body).toMatch(/alpha-lesson/);
    expect(b.tasks[1]!.body).toMatch(/beta-lesson/);
  });
  it('carries the journal integration procedure in the preamble (AC-2)', () => {
    const b = journalRecordBriefSlot({ learnings: [L('one'), L('two')] })[0]!;
    expect(b.preamble).toMatch(/\.mmagent\/journal/);
    expect(b.preamble).toMatch(/IN ORDER/);
    expect(b.preamble).toMatch(/FLUSH all writes|before the next/i);
  });
  it('treats tagHints as one batch-scoped array in the preamble (AC-11)', () => {
    const b = journalRecordBriefSlot({ learnings: [L('x')], tagHints: ['t1', 't2'] })[0]!;
    expect(b.preamble).toMatch(/t1, t2/);
  });
});
