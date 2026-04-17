import { z } from 'zod';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

export const commonToolFields = {
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
};

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasValidPaths(paths: string[] | undefined): boolean {
  return Array.isArray(paths) && paths.some(p => p.trim().length > 0);
}

export function validateInput(
  inlineContent: string | undefined,
  filePaths: string[] | undefined,
): { valid: true } | { valid: false; message: string } {
  if (hasContent(inlineContent) || hasValidPaths(filePaths)) {
    return { valid: true };
  }
  return { valid: false, message: 'Provide content or filePaths (or both)' };
}

export function resolveDispatchMode(
  inlineContent: string | undefined,
  filePaths: string[] | undefined,
): 'single' | 'fan_out' {
  if (hasContent(inlineContent)) return 'single';
  const validPaths = (filePaths ?? []).filter(p => p.trim().length > 0);
  if (validPaths.length >= 2) return 'fan_out';
  return 'single';
}

export function buildMetadataBlock(result: RunResult): { type: 'text'; text: string } {
  return {
    type: 'text' as const,
    text: JSON.stringify({
      status: result.status,
      terminationReason: result.terminationReason,
      specReviewStatus: result.specReviewStatus,
      qualityReviewStatus: result.qualityReviewStatus,
      specReviewReason: result.specReviewReason,
      qualityReviewReason: result.qualityReviewReason,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: result.usage.costUSD,
      },
      turns: result.turns,
      durationMs: result.durationMs,
      filesRead: result.filesRead,
      filesWritten: result.filesWritten,
      directoriesListed: result.directoriesListed ?? [],
      toolCalls: result.toolCalls,
      escalationLog: result.escalationLog,
      agents: result.agents,
    }, null, 2),
  };
}

export function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

export function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}
