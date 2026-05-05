import type { BriefSlotFiller } from '../brief-compiler.js';

export interface ReviewInput {
  filePaths: string[];
  checklist?: string;
  cwd?: string;
}

export interface ReviewBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
  filePath: string;
}

export const reviewSlot: BriefSlotFiller<ReviewInput, ReviewBrief[]> = (input) => {
  return input.filePaths.map((p, i) => ({
    taskIndex: i,
    brief: `Review ${p} against the project's review checklist:\n${input.checklist ?? '(default)'}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    contextBlockIds: [],
    filePath: p,
  }));
};
