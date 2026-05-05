import type { BriefSlotFiller } from '../brief-compiler.js';

export interface InvestigateInput {
  question: string;
  depth?: 'shallow' | 'medium' | 'deep';
  cwd?: string;
}

export interface InvestigateBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
}

export const investigateSlot: BriefSlotFiller<InvestigateInput, InvestigateBrief[]> = (input) => [{
  taskIndex: 0,
  brief: `Investigate (${input.depth ?? 'medium'}):\n${input.question}`,
  cwd: input.cwd ?? process.cwd(),
  agentType: 'complex',
  reviewPolicy: 'quality_only',
  contextBlockIds: [],
}];
