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
  /** Whether the warmer sent a cacheable prefix marker. Does NOT mean the
   *  upstream actually cached — see cacheHitConfirmed. */
  warmCacheControlSent: boolean;
  /** True iff at least one sub-worker reported cachedReadTokens > 0,
   *  proving the upstream cache hit. Computed AFTER fan-out. */
  cacheHitConfirmed: boolean;
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

/** Per-angle wall-clock cap. After this, the sub-worker's abortSignal fires
 *  and runOneSubWorker synthesizes a [N/A] finding so the merge annotator
 *  drops the angle gracefully. Bounds the worst-case max(angle wall) at
 *  10 min — total route wall ≈ warmer + 10 min + merge ≈ 13 min ceiling. */
const ANGLE_HARD_CAP_MS = 10 * 60 * 1000;

/** Soft warning checkpoint. Emits a verbose event so operators can see
 *  WHICH angles are slow before they hit the hard cap. No worker-side
 *  behavior change. */
const ANGLE_SOFT_WARN_MS = 5 * 60 * 1000;

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
): Promise<{ ok: true; output: SubWorkerOutput; capHit?: boolean } | { ok: false; failure: PartialFailure }> {
  input.bus?.emit({
    event: 'criteria_subworker_started',
    ts: new Date().toISOString(),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    criterionId: criterion.id,
    criterionTitle: criterion.title,
  });
  const startMs = Date.now();

  // Per-angle wall-clock guard: combine task-level abort with an
  // angle-level abort that fires at ANGLE_HARD_CAP_MS. The soft-warning
  // timer at ANGLE_SOFT_WARN_MS is observability-only.
  const angleAbort = new AbortController();
  const combinedAbort = new AbortController();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) combinedAbort.abort();
    else input.abortSignal.addEventListener('abort', () => combinedAbort.abort(), { once: true });
  }
  angleAbort.signal.addEventListener('abort', () => combinedAbort.abort(), { once: true });

  let capHit = false;
  const softTimer = setTimeout(() => {
    input.bus?.emit({
      event: 'criteria_subworker_soft_warning',
      ts: new Date().toISOString(),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      criterionId: criterion.id,
      criterionTitle: criterion.title,
      elapsedMs: ANGLE_SOFT_WARN_MS,
      remainingMs: ANGLE_HARD_CAP_MS - ANGLE_SOFT_WARN_MS,
    });
  }, ANGLE_SOFT_WARN_MS);
  const hardTimer = setTimeout(() => {
    capHit = true;
    input.bus?.emit({
      event: 'criteria_subworker_hard_cap',
      ts: new Date().toISOString(),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      criterionId: criterion.id,
      criterionTitle: criterion.title,
      elapsedMs: ANGLE_HARD_CAP_MS,
    });
    angleAbort.abort();
  }, ANGLE_HARD_CAP_MS);

  try {
    const result = await input.shell.run({
      systemPrompt: input.cachedPrefix,
      userMessage: input.buildSuffix(criterion),
      toolDefinitions: toolDefs,
      maxTurns: SAFETY_MAX_TURNS,
      cwd: input.cwd,
      abortSignal: combinedAbort.signal,
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
    // Hard-cap hit: synthesize a [N/A] finding so the merge annotator
    // drops it gracefully. Don't go through retry — the cap was deliberate.
    if (capHit || errorCode === 'aborted') {
      const synthetic = `## Finding 1: [N/A] Angle hit the ${Math.round(ANGLE_HARD_CAP_MS / 60000)}-minute per-angle wall-clock cap\n- Severity: low\n- Issue: This perspective was force-aborted to bound the route's overall wall-clock. Any partial findings collected before the cap have been discarded. The merge annotator drops this finding from the final report; it exists so you can see all angles were attempted.\n`;
      input.bus?.emit({
        event: 'criteria_subworker_completed',
        ts: new Date().toISOString(),
        ...(input.batchId !== undefined && { batchId: input.batchId }),
        ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
        criterionId: criterion.id,
        status: 'cap_hit',
        findingsCount: 0,
        durationMs: Date.now() - startMs,
        cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
      });
      return {
        ok: true,
        capHit: true,
        output: {
          criterionId: criterion.id,
          criterionTitle: criterion.title,
          narrative: synthetic,
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
    }
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
  } finally {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
  }
}

export async function dispatchParallelCriteria(input: DispatchInput): Promise<DispatchResult> {
  // makeToolDefinitions constructs a CWDValidator that synchronously
  // realpath()s the cwd; if cwd doesn't exist (test fixtures, future
  // ephemeral cwds) we fall back to an empty tool surface — the
  // sub-workers still have the inlined doc/files content in the cached
  // prefix and can answer without reading more files.
  let toolDefs: ToolDefinition[];
  if (input.toolDefinitions) {
    toolDefs = input.toolDefinitions;
  } else {
    try {
      toolDefs = filterToReadOnly(makeToolDefinitions({ cwd: input.cwd }));
    } catch (err) {
      input.bus?.emit({
        event: 'criteria_fanout_tools_unavailable',
        ts: new Date().toISOString(),
        ...(input.batchId !== undefined && { batchId: input.batchId }),
        ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
        reason: err instanceof Error ? err.message : String(err),
      });
      toolDefs = [];
    }
  }

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
      if (r.status === 'fulfilled') {
        const value = r.value;
        if (value.ok) {
          succeeded.push(value.output);
        } else {
          finalFailures.push(value.failure);
        }
      } else {
        const c = input.criteria[failedIndices[k]];
        finalFailures.push({ id: c.id, title: c.title, reason: 'other', lastError: String(r.reason) });
      }
    });
  }

  succeeded.sort((a, b) => Number(a.criterionId) - Number(b.criterionId));
  finalFailures.sort((a, b) => Number(a.id) - Number(b.id));

  const totalInputTokens = succeeded.reduce((a, s) => a + s.usage.inputTokens, 0);
  const totalCachedReadTokens = succeeded.reduce((a, s) => a + s.usage.cachedReadTokens, 0);
  const cacheHitConfirmed = totalCachedReadTokens > 0;
  // Cache hit ratio = cached_read / (cached_read + fresh_input). 1.0 means
  // every sub-worker served the prefix from cache; 0.0 means the warmer
  // didn't take effect.
  const cacheHitRatio = (totalCachedReadTokens + totalInputTokens) > 0
    ? totalCachedReadTokens / (totalCachedReadTokens + totalInputTokens)
    : 0;

  input.bus?.emit({
    event: 'criteria_fanout_summary',
    ts: new Date().toISOString(),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    ...(input.route !== undefined && { route: input.route }),
    parallelism: input.criteria.length,
    succeededCount: succeeded.length,
    failedCount: finalFailures.length,
    coveredIds: succeeded.map(s => s.criterionId),
    failedIds: finalFailures.map(f => f.id),
    warmCacheControlSent: warm.cacheControlSent,
    cacheHitConfirmed,
    cacheHitRatio: Math.round(cacheHitRatio * 1000) / 1000,
    warmDurationMs: warm.durationMs,
    totalInputTokens,
    totalCachedReadTokens,
    totalOutputTokens: succeeded.reduce((a, s) => a + s.usage.outputTokens, 0),
    totalCostUSD: succeeded.reduce((a, s) => a + (s.costUSD ?? 0), 0),
    longestSubWorkerMs: succeeded.reduce((a, s) => Math.max(a, s.durationMs), 0),
  });

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
    warmCacheControlSent: warm.cacheControlSent,
    cacheHitConfirmed,
    warmDurationMs: warm.durationMs,
    totalUsage,
  };
}
