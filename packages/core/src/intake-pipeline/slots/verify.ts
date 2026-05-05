import type { BriefSlotFiller } from '../brief-compiler.js';

export interface VerifyInput { checklist: string[]; cwd?: string }

export interface VerifyBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
}

export const verifySlot: BriefSlotFiller<VerifyInput, VerifyBrief[]> = (input) => [{
  taskIndex: 0,
  brief: `Verify the following checklist items:\n${input.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
  cwd: input.cwd ?? process.cwd(),
  agentType: 'complex',
  reviewPolicy: 'quality_only',
  contextBlockIds: [],
}];
