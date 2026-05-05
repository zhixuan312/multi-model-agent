import type { BriefSlotFiller } from '../brief-compiler.js';
import { extractPlanSection, PlanExtractionError } from '../plan-extractor.js';

export interface ExecutePlanInput {
  filePaths: [string];               // required; the first entry MUST be a plan file (no fileContents)
  taskDescriptors: string[];         // ATX heading texts to extract, in order
  cwd?: string;
  perTaskReviewPolicy?: Record<number, 'full' | 'quality_only' | 'diff_only' | 'none'>;
  // NOTE: agentType is intentionally absent — Zod schema rejects it (Step 2)
}

export interface ExecutePlanBrief {
  taskIndex: number;
  brief: string;                     // body of the matched plan section (<= 10 KB)
  cwd: string;
  agentType: 'standard';             // locked at intake
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  contextBlockIds: string[];
  autoCommit: true;                  // hardcoded per spec line 2076
}

export const executePlanSlot: BriefSlotFiller<ExecutePlanInput, ExecutePlanBrief[]> = (input) => {
  const planPath = input.filePaths[0];
  const cwd = input.cwd ?? process.cwd();
  return input.taskDescriptors.map((descriptor, i) => {
    const section = extractPlanSection(planPath, descriptor, cwd);
    return {
      taskIndex: i,
      brief: section.body,
      cwd,
      agentType: 'standard',
      reviewPolicy: input.perTaskReviewPolicy?.[i] ?? 'full',
      contextBlockIds: [],
      autoCommit: true,
    };
  });
};
