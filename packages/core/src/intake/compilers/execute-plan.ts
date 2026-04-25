import type { DraftTask, ExecutePlanSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export interface ExecutePlanInput {
  tasks: string[];
  fileContents: string;
  filePaths?: string[];
  reviewPolicy?: 'full' | 'spec_only' | 'diff_only' | 'off';
}

export function compileExecutePlan(
  input: ExecutePlanInput,
  requestId: string,
): DraftTask[] {
  return input.tasks.map((task, index) => {
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
    ].join('\n');

    return {
      draftId: createDraftId(requestId, index, `task-${index}`),
      source: {
        route: 'execute_plan',
        originalInput: { tasks: input.tasks, filePaths: input.filePaths, reviewPolicy: input.reviewPolicy } as unknown as Record<string, unknown>,
        filePaths: input.filePaths ?? [],
        task,
      } as ExecutePlanSource,
      prompt,
      reviewPolicy: input.reviewPolicy,
    };
  });
}
