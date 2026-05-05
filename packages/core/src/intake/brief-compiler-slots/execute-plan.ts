import type { DraftTask, ExecutePlanSource } from '../types.js';
import { createDraftId } from '../draft-id.js';
import type { ReviewPolicy } from './delegate.js';

const SCOPE_CONTRACT = `
Execute exactly the steps in the plan. Do NOT add steps not in the plan.
`.trim();

export interface ExecutePlanTaskInput {
  task: string;
  reviewPolicy?: ReviewPolicy;
}

export interface ExecutePlanCompilerInput {
  tasks: Array<string | ExecutePlanTaskInput>;
  fileContents: string;
  filePaths?: string[];
  verifyCommand?: string[];
}

function normalizeTask(input: string | ExecutePlanTaskInput): ExecutePlanTaskInput {
  return typeof input === 'string' ? { task: input } : input;
}

export function compileExecutePlan(
  input: ExecutePlanCompilerInput,
  requestId: string,
): DraftTask[] {
  return input.tasks.map((rawTask, index) => {
    const taskInput = normalizeTask(rawTask);
    const task = taskInput.task;
    const prompt = [
      'Below are the plan and/or spec documents for this project:',
      '',
      '---',
      input.fileContents,
      '---',
      '',
      'Execute the following task from the documents above:',
      '',
      `Requested task: "${task}"`,
      '',
      'Find this task in the plan/spec documents above (not in any preceding context blocks),',
      'understand its requirements, and implement it fully.',
      'Follow the plan exactly as written. If the plan provides code blocks, use them verbatim.',
      'Do not redesign, do not substitute your own approach.',
      'The plan was written by a higher-capability model — your job is to execute it faithfully.',
      'Follow any acceptance criteria, file paths, and constraints specified in the plan.',
      'If you cannot find a unique matching task, report that no match was found and do not implement anything.',
      '',
      SCOPE_CONTRACT,
    ].join('\n');

    return {
      draftId: createDraftId(requestId, index, `task-${index}`),
      source: {
        route: 'execute_plan',
        originalInput: { tasks: input.tasks, filePaths: input.filePaths } as Record<string, unknown>,
        filePaths: input.filePaths ?? [],
        task,
      } as ExecutePlanSource,
      prompt,
      reviewPolicy: taskInput.reviewPolicy,
      verifyCommand: input.verifyCommand,
    };
  });
}

// v4.0 spec C8 slot-style API. Distinct from compileExecutePlan above —
// the slot extracts plan sections via plan-extractor and emits agentType-locked briefs.
import { extractPlanSection } from '../plan-extractor.js';

export interface ExecutePlanInput {
  filePaths: [string] | string[];               // first entry MUST be a plan file
  taskDescriptors: string[];                    // ATX heading texts to extract, in order
  cwd?: string;
  perTaskReviewPolicy?: Record<number, ReviewPolicy>;
}

export interface ExecutePlanBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'standard';
  reviewPolicy: ReviewPolicy;
  contextBlockIds: string[];
  autoCommit: true;
}

export function executePlanSlot(input: ExecutePlanInput): ExecutePlanBrief[] {
  const planPath = input.filePaths[0];
  const cwd = input.cwd ?? process.cwd();
  return input.taskDescriptors.map((descriptor, i) => {
    const section = extractPlanSection(planPath, descriptor, cwd);
    return {
      taskIndex: i,
      brief: section.body,
      cwd,
      agentType: 'standard' as const,
      reviewPolicy: input.perTaskReviewPolicy?.[i] ?? 'full',
      contextBlockIds: [],
      autoCommit: true as const,
    };
  });
}
