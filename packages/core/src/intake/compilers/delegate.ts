import type { DraftTask, DelegateSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export type ReviewPolicy = 'full' | 'spec_only' | 'diff_only' | 'off';

export interface DelegateTaskInput {
  prompt: string;
  done?: string;
  filePaths?: string[];
  // Intentionally flexible: the delegate tool schema accepts runtime-defined
  // agent names as strings. execute-plan is stricter because it exposes only the
  // built-in standard/complex slots at intake.
  agentType?: string;
  contextBlockIds?: string[];
  reviewPolicy?: ReviewPolicy;
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
    const originalInput: Record<string, unknown> = structuredClone(task) as Record<string, unknown>;
    return {
      draftId: createDraftId(requestId, index, 'root'),
      source: {
        route: 'delegate_tasks',
        originalInput,
      } as DelegateSource,
      prompt: task.prompt,
      done: task.done,
      filePaths: task.filePaths,
      agentType: task.agentType,
      contextBlockIds: task.contextBlockIds,
      reviewPolicy: task.reviewPolicy ?? 'full',
    };
  });
}
