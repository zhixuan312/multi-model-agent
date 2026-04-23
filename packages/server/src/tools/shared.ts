import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  RunResult,
  MultiModelConfig,
  ContextBlockStore,
  TaskSpec,
  DiagnosticLogger,
} from '@zhixuan92/multi-model-agent-core';
import type { ClarificationEntry } from '@zhixuan92/multi-model-agent-core/intake/types';
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

/**
 * Auto-register task output(s) as a context block so callers can reference
 * the result in follow-up calls (e.g. round 2 of an audit) without manually
 * calling register_context_block. Diagnostic outputs are excluded.
 */
export function autoRegisterContextBlock(
  results: RunResult[],
  store: ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
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
export function buildRunTasksOptions(
  extra: { _meta?: Record<string, unknown>; sendNotification: (...args: any[]) => Promise<void> } | undefined,
): RunTasksOptions {
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
      const headline = `[task ${_taskIndex}] ${event.headline}`;
      void extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressCounter,
          message: headline,
        },
      });
    },
  };
}

type ExtraLike = {
  requestId?: string | number | null;
};

function coerceRequestId(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/**
 * Wrap an MCP tool handler so every call is recorded as request_start and
 * request_complete in the DiagnosticLogger. The start event is emitted before
 * the tool handler runs. The completion event is emitted on both success and
 * throw; thrown handlers record status:"error" with responseBytes:0.
 */
export function withDiagnostics<Args extends unknown[], R>(
  tool: string,
  logger: DiagnosticLogger,
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const rawExtra = args[args.length - 1] as unknown;
    const extra = (rawExtra && typeof rawExtra === 'object') ? rawExtra as ExtraLike : undefined;
    const requestId = coerceRequestId(extra?.requestId) ?? randomUUID();
    const startedAt = Date.now();
    logger.requestStart({ requestId, tool });
    try {
      const result = await handler(...args);
      let responseBytes = 0;
      try {
        responseBytes = Buffer.byteLength(JSON.stringify(result));
      } catch {
        responseBytes = 0;
      }
      logger.requestComplete({
        tool,
        requestId,
        durationMs: Date.now() - startedAt,
        responseBytes,
        status: 'ok',
      });
      return result;
    } catch (err) {
      logger.requestComplete({
        tool,
        requestId,
        durationMs: Date.now() - startedAt,
        responseBytes: 0,
        status: 'error',
      });
      throw err;
    }
  };
}

/**
 * Input interface for buildUnifiedResponse.
 */
export interface BuildUnifiedResponseInput {
  batchId: string;
  results: RunResult[];
  tasks: TaskSpec[];
  wallClockMs: number;
  parentModel?: string;
  contextBlockId?: string;
  clarificationId?: string;
  clarifications?: ClarificationEntry[];
}

export interface UnifiedResponse {
  headline: string;
  batchId: string;
  contextBlockId?: string;
  clarificationId?: string;
  clarifications?: ClarificationEntry[];
  results: {
    status: RunResult['status'];
    output: string;
    filesWritten: string[];
    error?: string;
  }[];
}

/**
 * Build a unified MCP response envelope for delegate_tasks / clarification flows.
 * Strips noisy internal fields (escalationLog, usage, turns, agents, models).
 */
export function buildUnifiedResponse(
  input: BuildUnifiedResponseInput,
): { content: { type: 'text'; text: string }[] } {
  const {
    batchId,
    results,
    tasks,
    wallClockMs,
    parentModel,
    contextBlockId,
    clarificationId,
    clarifications,
  } = input;

  const timings = computeTimings(wallClockMs, results);
  const batchProgress = computeBatchProgress(results);
  const aggregateCost = computeAggregateCost(results);
  const headline = composeHeadline({ timings, batchProgress, aggregateCost, parentModel });

  const response: UnifiedResponse = {
    headline,
    batchId,
    ...(contextBlockId && { contextBlockId }),
    ...(clarificationId && { clarificationId }),
    ...(clarifications && clarifications.length > 0 && { clarifications }),
    results: results.map((r) => ({
      status: r.status,
      output: r.output,
      filesWritten: r.filesWritten,
      ...(r.status === 'error' && r.error !== undefined && { error: r.error }),
    })),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
  };
}
