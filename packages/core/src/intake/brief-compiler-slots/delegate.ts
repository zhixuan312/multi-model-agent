import type { DraftTask, DelegateSource } from '../types.js';
import { createDraftId } from '../draft-id.js';
import { REVIEWER_AWARENESS_AP } from '../../review/templates/finding-criteria.js';

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

export function compileDelegatePrompt(input: { prompt: string; filePaths?: string[] }): string {
  // When the caller pinned filePaths, surface them as a hard constraint
  // in the prompt. v4.0.x dropped this on the floor — the brief carried
  // filePaths as metadata only and the worker freelanced filenames
  // (e.g. wrote `triangleArea.ts` for a `triangle.ts` ask). The worker
  // must write to EXACTLY these files; no synonyms, no rename, no extra.
  const filePathsClause = input.filePaths && input.filePaths.length > 0
    ? `\n\nFILE CONSTRAINT: write your code to exactly these file path(s), no others, no renames: ${input.filePaths.map((p) => `\`${p}\``).join(', ')}.`
    : '';
  // Tool sweep #12: tell the worker what the spec + quality reviewers
  // will judge AGAINST so the worker self-aligns. Pre-fix the worker
  // wrote code blind to the rubric, the reviewer flagged spec mismatches
  // the worker could have caught itself, and the rework loop spiraled.
  // Now: worker calibrates against the same criteria → first-round
  // approvals are the norm, rework triggers only on real mistakes.
  return `${input.prompt}\n\n${SCOPE_CONTRACT}${filePathsClause}\n\n${REVIEWER_AWARENESS_AP}`;
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
      prompt: compileDelegatePrompt({ prompt: task.prompt, filePaths: task.filePaths }),
      done: task.done,
      filePaths: task.filePaths,
      agentType: task.agentType,
      contextBlockIds: task.contextBlockIds,
      reviewPolicy: task.reviewPolicy,
      verifyCommand: task.verifyCommand,
    };
  });
}

// v4.0 spec C8 slot-style API: a BriefSlotFiller that takes a tasks[] envelope
// and returns per-task DelegateBrief records. Wraps compileDelegateTasks.
export interface DelegateInput {
  tasks: DelegateTaskInput[];
  requestId?: string;
}

export interface DelegateBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: ReviewPolicy;
  contextBlockIds: string[];
}

export function delegateSlot(input: DelegateInput): DelegateBrief[] {
  const requestId = input.requestId ?? 'req-' + Date.now().toString(36);
  const drafts = compileDelegateTasks(input.tasks, requestId);
  return drafts.map((draft, index) => ({
    taskIndex: index,
    brief: draft.prompt,
    cwd: process.cwd(),
    agentType: draft.agentType ?? 'standard',
    reviewPolicy: draft.reviewPolicy ?? 'full',
    contextBlockIds: draft.contextBlockIds ?? [],
  }));
}
