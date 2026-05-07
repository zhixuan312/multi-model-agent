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
// v4.0 spec C8 slot-style API
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

export function debugSlot(input: DebugInput): DebugBrief[] {
  return [{
    taskIndex: 0,
    brief: `Debug:\n${input.problemStatement}\n\nRepro:\n${input.reproSteps ?? '(none)'}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    contextBlockIds: [],
  }];
}

// ── Generic executor brief slot ──

export interface ToolDebugBrief {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
  contextBlockIds?: string[];
}

/**
 * Compiles the tool input into a single brief for the generic task executor.
 * Debug always produces exactly 1 task.
 */
export function debugBriefSlot(input: {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
  contextBlockIds?: string[];
}): ToolDebugBrief[] {
  return [{ problem: input.problem, context: input.context, hypothesis: input.hypothesis, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }];
}
