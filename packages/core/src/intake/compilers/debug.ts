import type { DraftTask, DebugSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export interface DebugTaskInput {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
}

export function compileDebugTask(
  input: DebugTaskInput,
  requestId: string,
): DraftTask[] {
  const promptParts: string[] = [];

  promptParts.push(`Problem to debug: ${input.problem}`);
  if (input.context) {
    promptParts.push(`\nContext:\n${input.context}`);
  }
  if (input.hypothesis) {
    promptParts.push(`\nHypothesis: ${input.hypothesis}`);
  }
  if (input.filePaths?.length) {
    promptParts.push(`\nFiles involved: ${input.filePaths.join(', ')}`);
  }

  return [{
    draftId: createDraftId(requestId, 0, 'root'),
    source: {
      route: 'debug_task',
      originalInput: input as unknown as Record<string, unknown>,
      problem: input.problem,
      context: input.context,
      hypothesis: input.hypothesis,
    } as DebugSource,
    prompt: promptParts.join(''),
    filePaths: input.filePaths,
  }];
}