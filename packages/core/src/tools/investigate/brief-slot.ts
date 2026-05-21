import type { Input } from './schema.js';

// ── Enriched input: the handler canonicalizes file paths before passing
//    them here, so briefSlot operates on resolved data.

export interface EnrichedInvestigateInput extends Input {
  canonicalizedFilePaths: string[];
}

export interface InvestigateBrief {
  /** The user's original question — drives both the headline text and the
   *  read-route target (the worker's prompt comes from the dispatcher's
   *  cached prefix built from `readTarget`, not from this brief). */
  question: string;
  filePaths: string[];
  contextBlockIds: string[];
  tools?: 'none' | 'readonly';
}

export const investigateBriefSlot = (input: EnrichedInvestigateInput): InvestigateBrief[] => {
  return [{
    question: input.question,
    filePaths: input.canonicalizedFilePaths,
    contextBlockIds: input.contextBlockIds ?? [],
    tools: input.tools,
  }];
};
