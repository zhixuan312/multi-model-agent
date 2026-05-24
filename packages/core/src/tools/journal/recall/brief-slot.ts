// packages/core/src/tools/journal/recall/brief-slot.ts
import type { Input } from './schema.js';
export interface JournalRecallBrief { query: string; contextBlockIds: string[]; }
export const journalRecallBriefSlot = (input: Input): JournalRecallBrief[] => [{
  query: input.query,
  contextBlockIds: input.contextBlockIds ?? [],
}];
