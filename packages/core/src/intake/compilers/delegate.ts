import type { DraftTask, DelegateSource } from '../types.js';
import { createDraftId } from '../draft-id.js';

export interface DelegateTaskInput {
  prompt: string;
  done?: string;
  filePaths?: string[];
  agentType?: string;
  contextBlockIds?: string[];
  reviewPolicy?: 'full' | 'spec_only' | 'diff_only' | 'off';
}

export function compileDelegateTasks(
  tasks: DelegateTaskInput[],
  requestId: string,
): DraftTask[] {
  return tasks.map((task, index) => ({
    draftId: createDraftId(requestId, index, 'root'),
    source: {
      route: 'delegate_tasks',
      originalInput: structuredClone(task) as unknown as Record<string, unknown>,
    } as DelegateSource,
    prompt: task.prompt,
    done: task.done,
    filePaths: task.filePaths,
    agentType: task.agentType,
    contextBlockIds: task.contextBlockIds,
    reviewPolicy: task.reviewPolicy,
  }));
}