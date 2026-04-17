import type { DraftTask, VerifySource } from '../types.js';
import { createDraftId, escapeFanoutKey, canonicalizePath } from '../draft-id.js';

export interface VerifyWorkInput {
  work?: string;
  filePaths?: string[];
  checklist: string[];
}

export function compileVerifyWork(
  input: VerifyWorkInput,
  requestId: string,
): DraftTask[] {
  const filePaths = input.filePaths ?? [];

  if (filePaths.length <= 1) {
    const promptParts: string[] = [];
    if (input.work) promptParts.push(`Work to verify:\n${input.work}`);
    if (filePaths.length) promptParts.push(`\nFiles to check: ${filePaths.join(', ')}`);
    if (input.checklist.length) promptParts.push(`\nChecklist:\n${input.checklist.map(c => `- ${c}`).join('\n')}`);
    promptParts.push('For each checklist item, indicate pass/fail and provide evidence.');

    return [{
      draftId: createDraftId(requestId, 0, 'root'),
      source: {
        route: 'verify_work',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        checklist: input.checklist,
        work: input.work,
      } as VerifySource,
      prompt: promptParts.join('\n'),
      filePaths,
    }];
  }

  return filePaths.map((filePath, index) => {
    const nodeId = escapeFanoutKey(canonicalizePath(filePath));
    const promptParts: string[] = [];
    promptParts.push(`Verify this file: ${filePath}`);
    if (input.checklist.length) promptParts.push(`Checklist:\n${input.checklist.map(c => `- ${c}`).join('\n')}`);
    promptParts.push('For each checklist item, indicate pass/fail and provide evidence.');

    return {
      draftId: createDraftId(requestId, index, nodeId),
      source: {
        route: 'verify_work',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        checklist: input.checklist,
        work: input.work,
      } as VerifySource,
      prompt: promptParts.join('\n'),
      filePaths: [filePath],
    };
  });
}