// tests/tools/journal-recall-brief.test.ts
import { journalRecallBriefSlot } from '../../packages/core/src/tools/journal/recall/brief-slot.js';
it('produces one brief carrying the query', () => {
  const b = journalRecallBriefSlot({ query: 'dispatch cancellation reliability', contextBlockIds: [] });
  expect(b).toHaveLength(1);
  expect(b[0].query).toBe('dispatch cancellation reliability');
});
