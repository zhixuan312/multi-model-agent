import type { DraftTask, DelegateSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export type ReviewPolicy = 'full' | 'quality_only' | 'diff_only' | 'none';

export interface DelegateTaskInput {
  prompt: string;
  done?: string;
  filePaths?: string[];
  agentType?: 'standard' | 'complex';
  contextBlockIds?: string[];
  reviewPolicy?: ReviewPolicy;
  verifyCommand?: string[];
}

const SCOPE_CONTRACT = `Stay scoped to the explicit task description. Do NOT enlarge the task. If the task references files, read those files first; do not enumerate adjacent ones.`;

export function compileDelegatePrompt(input: { prompt: string }): string {
  return `${input.prompt}\n\n${SCOPE_CONTRACT}`;
}

export function compileDelegateTasks(
  tasks: DelegateTaskInput[] | null | undefined,
  requestId: string,
): DraftTask[] {
  if (tasks == null) {
    console.warn('compileDelegateTasks: tasks is null/undefined; returning no drafts');
    return [];
  }
  if (tasks.length === 0) {
    return [];
  }

  return tasks.map((task, index) => {
    const originalInput: Record<string, unknown> = structuredClone(task) as unknown as Record<string, unknown>;
    return {
      draftId: createDraftId(requestId, index, 'root'),
      source: {
        route: 'delegate_tasks',
        originalInput,
      } as DelegateSource,
      prompt: compileDelegatePrompt(task),
      done: task.done,
      filePaths: task.filePaths,
      agentType: task.agentType,
      contextBlockIds: task.contextBlockIds,
      reviewPolicy: task.reviewPolicy,
      verifyCommand: task.verifyCommand,
    };
  });
}
