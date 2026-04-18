import type { DraftTask, ExecutePlanSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export interface ExecutePlanInput {
  tasks: string[];
  fileContents: string;
  filePaths?: string[];
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
      'Follow any acceptance criteria, file paths, and constraints specified in the plan.',
      'If you cannot find a unique matching task, report that no match was found and do not implement anything.',
    ].join('\n');

    return {
      draftId: createDraftId(requestId, index, `task-${index}`),
      source: {
        route: 'execute_plan',
        originalInput: { tasks: input.tasks, filePaths: input.filePaths } as unknown as Record<string, unknown>,
        filePaths: input.filePaths ?? [],
        task,
      } as ExecutePlanSource,
      prompt,
    };
  });
}
