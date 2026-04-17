import { z } from 'zod';
import type { RunResult, MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import type { ProgressEvent } from '@zhixuan92/multi-model-agent-core';
import type { RunTasksOptions } from '@zhixuan92/multi-model-agent-core/run-tasks';
import { composeHeadline } from '../headline.js';
import { computeTimings, computeBatchProgress, computeAggregateCost } from './batch-response.js';

export const commonToolFields = {
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
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

export function buildMetadataBlock(result: RunResult, parentModel?: string): { type: 'text'; text: string } {
  const timings = computeTimings(result.durationMs ?? 0, [result]);
  const batchProgress = computeBatchProgress([result]);
  const aggregateCost = computeAggregateCost([result]);
  const headline = composeHeadline({ timings, batchProgress, aggregateCost, parentModel });

  return {
    type: 'text' as const,
    text: JSON.stringify({
      headline,
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
        savedCostUSD: result.usage.savedCostUSD,
      },
      turns: result.turns,
      durationMs: result.durationMs,
      filesRead: result.filesRead,
      filesWritten: result.filesWritten,
      directoriesListed: result.directoriesListed ?? [],
      toolCalls: result.toolCalls,
      escalationLog: result.escalationLog,
      agents: result.agents,
      models: result.models,
    }, null, 2),
  };
}

export function resolveParentModel(config: MultiModelConfig): string | undefined {
  return process.env.PARENT_MODEL_NAME || config.defaults?.parentModel || undefined;
}

export function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

export function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildRunTasksOptions(extra?: { _meta?: Record<string, unknown>; sendNotification: (...args: any[]) => Promise<void> }): RunTasksOptions {
  if (!extra) return {};
  const rawToken = extra._meta?.progressToken;
  const progressToken: string | number | undefined =
    typeof rawToken === 'string' || typeof rawToken === 'number'
      ? rawToken
      : undefined;
  let progressCounter = 0;

  if (progressToken === undefined) return {};

  return {
    onProgress: (_taskIndex: number, event: ProgressEvent) => {
      progressCounter += 1;
      extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressCounter,
          message: JSON.stringify({ taskIndex: _taskIndex, event }),
        },
      }).catch(() => { /* ignore */ });
    },
  };
}
