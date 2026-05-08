import type { Input } from '../../tools/review/schema.js';

export interface ReviewBrief {
  filePath?: string;
  code?: string;
  filePaths?: string[];
  focus?: string[];
  hasContextBlocks: boolean;
  contextBlockIds: string[];
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function reviewBriefSlot(input: Input): ReviewBrief[] {
  const hasContextBlocks = Array.isArray(input.contextBlockIds) && input.contextBlockIds.length > 0;
  const validPaths = (input.filePaths ?? []).filter(p => p.trim().length > 0);

  if (hasContent(input.code) || validPaths.length <= 1) {
    return [{
      code: input.code,
      filePaths: input.filePaths,
      focus: input.focus,
      hasContextBlocks,
      contextBlockIds: input.contextBlockIds ?? [],
    }];
  }

  return validPaths.map(fp => ({
    filePath: fp,
    focus: input.focus,
    hasContextBlocks,
    contextBlockIds: input.contextBlockIds ?? [],
  }));
}
