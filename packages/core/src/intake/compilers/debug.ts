import type { DraftTask, DebugSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export interface DebugTaskInput {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
}

const SCOPE_CONTRACT = `
Reproduce the reported failure first. Read code along the failure path. Do NOT speculatively read unrelated subsystems.
`.trim();

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

  promptParts.push(`\n${SCOPE_CONTRACT}`);

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
    skipCompletionHeuristic: true,
  }];
}