import { z } from 'zod';
import type { TaskSpec, ToolMode, RunResult } from '@zhixuan92/multi-model-agent-core';

export const commonToolFields = {
  filePaths: z.array(z.string()).optional()
    .describe('File paths for the agent to work with. When provided without inline content, each file becomes a separate parallel task.'),
  cwd: z.string().optional()
    .describe('Working directory for file access. Defaults to server process.cwd().'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs of registered context blocks to prepend to prompt.'),
  tools: z.enum(['none', 'readonly', 'full']).optional()
    .describe('Tool access level for the sub-agent. Defaults to full.'),
  maxCostUSD: z.number().nonnegative().optional()
    .describe('Cost ceiling in USD. Task terminates with cost_exceeded when hit.'),
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
      workerStatus: result.workerStatus,
      specReviewStatus: result.specReviewStatus,
      qualityReviewStatus: result.qualityReviewStatus,
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

export function applyCommonFields(
  taskSpec: Partial<TaskSpec>,
  params: { cwd?: string; contextBlockIds?: string[]; tools?: ToolMode; maxCostUSD?: number },
): Partial<TaskSpec> {
  const result = { ...taskSpec };
  if (params.cwd !== undefined) result.cwd = params.cwd;
  if (params.contextBlockIds !== undefined) result.contextBlockIds = params.contextBlockIds;
  if (params.tools !== undefined) result.tools = params.tools;
  if (params.maxCostUSD !== undefined) result.maxCostUSD = params.maxCostUSD;
  return result;
}
