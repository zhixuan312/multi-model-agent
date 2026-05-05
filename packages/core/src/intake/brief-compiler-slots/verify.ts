import type { DraftTask, VerifySource } from '../types.js';
import { createDraftId, escapeFanoutKey, canonicalizePath } from '../draft-id.js';

export interface VerifyWorkInput {
  work?: string;
  filePaths?: string[];
  checklist: string[];
}

const SCOPE_CONTRACT = [
  'Run the supplied verification command(s) and report.',
  'Do NOT explore or refactor.',
  'Read source only when the command output is ambiguous.',
].join(' ');

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
    promptParts.push(SCOPE_CONTRACT);

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
    promptParts.push(SCOPE_CONTRACT);

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
// v4.0 spec C8 slot-style API
export interface VerifyInput { checklist: string[]; cwd?: string }

export interface VerifyBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
}

export function verifySlot(input: VerifyInput): VerifyBrief[] {
  return [{
    taskIndex: 0,
    brief: `Verify the following checklist items:\n${input.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    contextBlockIds: [],
  }];
}
