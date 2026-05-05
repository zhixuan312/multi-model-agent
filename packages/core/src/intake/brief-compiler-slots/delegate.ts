import type { BriefSlotFiller } from '../brief-compiler.js';

export interface DelegateInput {
  tasks: Array<{
    brief: string;
    cwd?: string;
    agentType?: 'standard' | 'complex';
    reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
    contextBlockIds?: string[];
  }>;
}

export interface DelegateBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  contextBlockIds: string[];
}

export const delegateSlot: BriefSlotFiller<DelegateInput, DelegateBrief[]> = (input) => {
  return input.tasks.map((t, i) => ({
    taskIndex: i,
    brief: t.brief,
    cwd: t.cwd ?? process.cwd(),
    agentType: t.agentType ?? 'standard',
    reviewPolicy: t.reviewPolicy ?? 'full',
    contextBlockIds: t.contextBlockIds ?? [],
  }));
};
