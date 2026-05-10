import type { RunnerShell } from '../providers/runner-shell.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { ToolDefinition } from '../providers/runner-shell-types.js';
import { SAFETY_MAX_TURNS } from '../bounded-execution/safety-max-turns.js';
import { makeToolDefinitions } from '../providers/tool-definitions.js';
import { WRITE_TOOL_NAMES, SHELL_TOOL_NAMES } from '../providers/tool-name-sets.js';
import type { CriterionEntry } from '../tools/criteria-types.js';

/**
 * Filters out write + shell tools from the standard tool surface so
 * sub-workers in a read-only fan-out can't accidentally mutate the cwd.
 * Read tools (read_file, grep, glob, listFiles) and any other non-write
 * tools (web_search etc.) pass through.
 */
function filterToReadOnly(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.filter(d => !WRITE_TOOL_NAMES.has(d.name) && !SHELL_TOOL_NAMES.has(d.name));
}

export interface SubWorkerOutput {
  criterionId: string;
  criterionTitle: string;
  narrative: string;
  usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
  turns: number;
  toolCallCount: number;
  durationMs: number;
  costUSD: number | null;
}

export interface PartialFailure {
  id: string;
  title: string;
  reason: 'timeout' | 'transport' | 'parse' | 'other';
  lastError: string;
}

export interface DispatchResult {
  workerOutputs: SubWorkerOutput[];
  partialCriteriaCovered: string[];
  partialCriteriaFailed: PartialFailure[];
  warmCacheWritten: boolean;
  warmDurationMs: number;
  /** Aggregate usage across all sub-workers (sum). */
  totalUsage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
}

export interface DispatchInput {
  shell: RunnerShell;
  cachedPrefix: string;
  criteria: readonly CriterionEntry[];
  buildSuffix: (c: CriterionEntry) => string;
  cwd: string;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  bus?: EventEmitter;
  batchId?: string;
  taskIndex?: number;
  tier?: string;
  /** Override the default read-only tool surface; rare. */
  toolDefinitions?: ToolDefinition[];
  route?: string;
}

const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'transport_failure', 'provider_transport_failure', 'api_error', 'network_error',
]);

function classifyFailureReason(errorCode: string | undefined): PartialFailure['reason'] {
  if (!errorCode) return 'other';
  if (errorCode === 'timeout' || errorCode.includes('time')) return 'timeout';
  if (TRANSPORT_FAILURE_CODES.has(errorCode) || errorCode.includes('transport')) return 'transport';
  if (errorCode.includes('parse')) return 'parse';
  return 'other';
}

async function runOneSubWorker(
  input: DispatchInput,
  criterion: CriterionEntry,
  toolDefs: ToolDefinition[],
): Promise<{ ok: true; output: SubWorkerOutput } | { ok: false; failure: PartialFailure }> {
  input.bus?.emit({
    event: 'criteria_subworker_started',
    ts: new Date().toISOString(),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    criterionId: criterion.id,
    criterionTitle: criterion.title,
  });
  const startMs = Date.now();
  try {
    const result = await input.shell.run({
      systemPrompt: input.cachedPrefix,
      userMessage: input.buildSuffix(criterion),
      toolDefinitions: toolDefs,
      maxTurns: SAFETY_MAX_TURNS,
      cwd: input.cwd,
      ...(input.abortSignal && { abortSignal: input.abortSignal }),
      ...(input.deadlineMs !== undefined && { deadlineMs: input.deadlineMs }),
      cacheControl: { type: 'ephemeral' },
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.tier !== undefined && { tier: input.tier }),
      stageLabel: `Criterion ${criterion.id}`,
    });
    const text = result.finalAssistantText ?? '';
    const errorCode = result.errorCode;
    const isFailure =
      (errorCode !== undefined && TRANSPORT_FAILURE_CODES.has(errorCode)) ||
      (text.trim().length === 0 && result.workerStatus !== 'done');
    if (isFailure) {
      input.bus?.emit({
        event: 'criteria_subworker_completed',
        ts: new Date().toISOString(),
        ...(input.batchId !== undefined && { batchId: input.batchId }),
        ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
        criterionId: criterion.id,
        status: 'failed',
        durationMs: Date.now() - startMs,
        cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
      });
      return {
        ok: false,
        failure: {
          id: criterion.id,
          title: criterion.title,
          reason: classifyFailureReason(errorCode),
          lastError: errorCode ?? 'empty output',
        },
      };
    }
    const findingsCount = (text.match(/^## Finding \d+:/gm) ?? []).length;
    input.bus?.emit({
      event: 'criteria_subworker_completed',
      ts: new Date().toISOString(),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      criterionId: criterion.id,
      status: 'ok',
      findingsCount,
      durationMs: Date.now() - startMs,
      cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
    });
    return {
      ok: true,
      output: {
        criterionId: criterion.id,
        criterionTitle: criterion.title,
        narrative: text,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
          cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
        },
        turns: result.turns ?? 0,
        toolCallCount: result.toolCalls?.length ?? 0,
        durationMs: result.durationMs ?? Date.now() - startMs,
        costUSD: result.costUSD ?? null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failure: { id: criterion.id, title: criterion.title, reason: 'other', lastError: message } };
  }
}

export async function dispatchParallelCriteria(input: DispatchInput): Promise<DispatchResult> {
  const toolDefs = input.toolDefinitions ?? filterToReadOnly(makeToolDefinitions({ cwd: input.cwd }));

  input.bus?.emit({
    event: 'criteria_fanout_warm_start',
    ts: new Date().toISOString(),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    parallelism: input.criteria.length,
    ...(input.route !== undefined && { route: input.route }),
  });
  const warm = await input.shell.prime(input.cachedPrefix, {
    cwd: input.cwd,
    cacheControl: { type: 'ephemeral' },
    ...(input.abortSignal && { abortSignal: input.abortSignal }),
    ...(input.deadlineMs !== undefined && { deadlineMs: input.deadlineMs }),
    ...(input.bus && { bus: input.bus }),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    ...(input.tier !== undefined && { tier: input.tier }),
    stageLabel: 'Cache warmer',
  });

  const firstResults = await Promise.allSettled(input.criteria.map(c => runOneSubWorker(input, c, toolDefs)));
  const succeeded: SubWorkerOutput[] = [];
  const failedIndices: number[] = [];
  firstResults.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.ok) succeeded.push(r.value.output);
    else failedIndices.push(i);
  });

  const finalFailures: PartialFailure[] = [];
  if (failedIndices.length > 0) {
    input.bus?.emit({
      event: 'criteria_subworker_retry',
      ts: new Date().toISOString(),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      retriedCount: failedIndices.length,
    });
    const retryResults = await Promise.allSettled(failedIndices.map(i => runOneSubWorker(input, input.criteria[i], toolDefs)));
    retryResults.forEach((r, k) => {
      if (r.status === 'fulfilled' && r.value.ok) succeeded.push(r.value.output);
      else if (r.status === 'fulfilled') finalFailures.push(r.value.failure);
      else {
        const c = input.criteria[failedIndices[k]];
        finalFailures.push({ id: c.id, title: c.title, reason: 'other', lastError: String(r.reason) });
      }
    });
  }

  succeeded.sort((a, b) => Number(a.criterionId) - Number(b.criterionId));
  finalFailures.sort((a, b) => Number(a.id) - Number(b.id));

  const totalUsage = succeeded.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.usage.inputTokens,
      outputTokens: acc.outputTokens + s.usage.outputTokens,
      cachedReadTokens: acc.cachedReadTokens + s.usage.cachedReadTokens,
      cachedNonReadTokens: acc.cachedNonReadTokens + s.usage.cachedNonReadTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  );

  return {
    workerOutputs: succeeded,
    partialCriteriaCovered: succeeded.map(s => s.criterionId),
    partialCriteriaFailed: finalFailures,
    warmCacheWritten: warm.cacheWritten,
    warmDurationMs: warm.durationMs,
    totalUsage,
  };
}
