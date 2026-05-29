import { journalRecordBriefSlot } from '../../packages/core/src/tools/journal/record/brief-slot.js';

const L = (s: string) => s.padEnd(20, '.');

describe('journal record brief', () => {
  it('produces exactly ONE brief regardless of learnings count (AC-10)', () => {
    expect(journalRecordBriefSlot({ learnings: [L('a'), L('b'), L('c')] })).toHaveLength(1);
  });
  it('embeds every learning and the journal rules', () => {
    const p = journalRecordBriefSlot({ learnings: [L('alpha-lesson'), L('beta-lesson')] })[0].prompt;
    expect(p).toMatch(/\.mmagent\/journal/);
    expect(p).toMatch(/alpha-lesson/);
    expect(p).toMatch(/beta-lesson/);
  });
  it('instructs ordered, flush-between-each integration (AC-2)', () => {
    const p = journalRecordBriefSlot({ learnings: [L('one'), L('two')] })[0].prompt;
    expect(p).toMatch(/IN ORDER/);                       // from compile() + procedure
    expect(p).toMatch(/FLUSH all writes|before the next/i); // from procedure step 5
  });
  it('sets complex agent type', () => {
    expect(journalRecordBriefSlot({ learnings: [L('x')] })[0].agentType).toBe('complex');
  });
  it('treats tagHints as one batch-scoped array, not per-learning (AC-11)', () => {
    const p = journalRecordBriefSlot({ learnings: [L('x')], tagHints: ['t1', 't2'] })[0].prompt;
    expect(p).toMatch(/t1, t2/);
  });
});
