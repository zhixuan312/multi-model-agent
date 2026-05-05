import type { BriefSlotFiller } from '../brief-compiler.js';

export interface DebugInput {
  problemStatement: string;
  reproSteps?: string;
  cwd?: string;
}

export interface DebugBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
}

export const debugSlot: BriefSlotFiller<DebugInput, DebugBrief[]> = (input) => [{
  taskIndex: 0,
  brief: `Debug:\n${input.problemStatement}\n\nRepro:\n${input.reproSteps ?? '(none)'}`,
  cwd: input.cwd ?? process.cwd(),
  agentType: 'complex',
  reviewPolicy: 'quality_only',
  contextBlockIds: [],
}];
