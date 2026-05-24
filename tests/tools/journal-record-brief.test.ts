import { journalRecordBriefSlot } from '../../packages/core/src/tools/journal/record/brief-slot.js';
describe('journal record brief', () => {
  it('produces exactly one brief whose prompt embeds the learning + journal rules', () => {
    const briefs = journalRecordBriefSlot({ learning: 'tried X, dropped it, lesson Y'.padEnd(20,'.') });
    expect(briefs).toHaveLength(1);
    expect(briefs[0].prompt).toMatch(/\.mmagent\/journal/);
    expect(briefs[0].prompt).toMatch(/create \/ refine \/ supersede \/ merge|create|supersede/);
    expect(briefs[0].agentType).toBe('complex');
  });
});
