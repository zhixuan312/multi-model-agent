import type { DraftTask, ReviewSource } from '../types.js';
import { createDraftId, escapeFanoutKey, canonicalizePath } from '../draft-id.js';

const SCOPE_CONTRACT = `Review the specified files in scope. Cross-reference call sites and types only when needed to validate a finding. Do NOT review code outside the requested scope.`;

export interface ReviewCodeInput {
  code?: string;
  inlineContent?: string;
  filePaths?: string[];
  focus?: string[];
}

export function compileReviewCode(
  input: ReviewCodeInput,
  requestId: string,
): DraftTask[] {
  const filePaths = input.filePaths ?? [];

  if (filePaths.length <= 1 && !input.code && !input.inlineContent) {
    const nodeId = filePaths.length === 1 ? escapeFanoutKey(canonicalizePath(filePaths[0])) : 'root';
    const promptParts: string[] = [];
    if (filePaths.length) promptParts.push(`Files to review: ${filePaths.join(', ')}`);
    if (input.focus?.length) promptParts.push(`Focus areas: ${input.focus.join(', ')}`);
    promptParts.push('Provide a structured review with findings and recommendations.');
    promptParts.push(SCOPE_CONTRACT);

    return [{
      draftId: createDraftId(requestId, 0, nodeId),
      source: {
        route: 'review_code',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        code: input.code,
        inlineContent: input.inlineContent,
        focus: input.focus,
      } as ReviewSource,
      prompt: promptParts.join('\n\n'),
      filePaths,
      skipCompletionHeuristic: true,
    }];
  }

  return filePaths.map((filePath, index) => {
    const nodeId = escapeFanoutKey(canonicalizePath(filePath));
    const promptParts: string[] = [];
    promptParts.push(`Review this file: ${filePath}`);
    if (input.focus?.length) promptParts.push(`Focus areas: ${input.focus.join(', ')}`);
    promptParts.push('Provide a structured review with findings and recommendations.');
    promptParts.push(SCOPE_CONTRACT);

    return {
      draftId: createDraftId(requestId, index, nodeId),
      source: {
        route: 'review_code',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        code: input.code,
        inlineContent: input.inlineContent,
        focus: input.focus,
      } as ReviewSource,
      prompt: promptParts.join('\n\n'),
      filePaths: [filePath],
      skipCompletionHeuristic: true,
    };
  });
}
// v4.0 spec C8 slot-style API
export interface ReviewInput {
  filePaths: string[];
  checklist?: string;
  cwd?: string;
}

export interface ReviewBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
  filePath: string;
}

export function reviewSlot(input: ReviewInput): ReviewBrief[] {
  return input.filePaths.map((p, i) => ({
    taskIndex: i,
    brief: `Review ${p} against the project's review checklist:\n${input.checklist ?? '(default)'}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    contextBlockIds: [],
    filePath: p,
  }));
}
