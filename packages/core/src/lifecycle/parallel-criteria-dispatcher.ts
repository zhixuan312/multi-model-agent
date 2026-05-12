import type { Session, SessionOpts } from '../types/run-result.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { CriterionEntry } from '../tools/criteria-types.js';

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
  /**
   * Factory that opens a fresh per-criterion `Session` against the
   * configured tier's provider. Each sub-worker gets its own session
   * (no thread sharing) — fan-outs are independent runs against the
   * same cached prefix, not branches of a shared conversation.
   */
  openSession: (opts: SessionOpts) => Session;
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

  const session = input.openSession({
    cwd: input.cwd,
    wallClockDeadline: input.deadlineMs ?? (Date.now() + ANGLE_HARD_CAP_MS),
    idleStallTimeoutMs: 20 * 60 * 1000,
    abortSignal: combinedAbort.signal,
    ...(input.bus && { bus: input.bus as unknown as object }),
  });
  try {
    const instruction = `${input.cachedPrefix}\n\n${input.buildSuffix(criterion)}`;
    const turn = await session.send(instruction, {
      stageLabel: `Criterion ${criterion.id}`,
    });
    const result = {
      finalAssistantText: turn.output,
      errorCode: turn.errorCode,
      terminationReason: turn.terminationReason,
      usage: turn.usage,
      turns: turn.turns,
      toolCalls: Object.values(turn.toolCallsByName).reduce((a, b) => a + b, 0),
      durationMs: turn.durationMs,
      costUSD: turn.costUSD,
    };
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
          toolCallCount: result.toolCalls ?? 0,
          durationMs: result.durationMs ?? Date.now() - startMs,
          costUSD: result.costUSD ?? null,
        },
      };
    }
    const isFailure =
      (errorCode !== undefined && TRANSPORT_FAILURE_CODES.has(errorCode)) ||
      (text.trim().length === 0 && result.terminationReason !== 'ok');
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
        toolCallCount: result.toolCalls ?? 0,
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
    try { await session.close(); } catch { /* best-effort cleanup */ }
  }
}

export async function dispatchParallelCriteria(input: DispatchInput): Promise<DispatchResult> {
  // v4.4: Each sub-worker opens its own native session (claude-agent-sdk or
  // codex CLI) and sends the cached prefix inline as part of its first
  // instruction. There is no separate warmer turn — upstream caching is
  // the provider's job, not ours.
  input.bus?.emit({
    event: 'criteria_fanout_start',
    ts: new Date().toISOString(),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
    parallelism: input.criteria.length,
    ...(input.route !== undefined && { route: input.route }),
  });
  const fanoutStartMs = Date.now();

  const firstResults = await Promise.allSettled(input.criteria.map(c => runOneSubWorker(input, c)));
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
    const retryResults = await Promise.allSettled(failedIndices.map(i => runOneSubWorker(input, input.criteria[i])));
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
  const cacheHitRatio = (totalCachedReadTokens + totalInputTokens) > 0
    ? totalCachedReadTokens / (totalCachedReadTokens + totalInputTokens)
    : 0;
  const fanoutDurationMs = Date.now() - fanoutStartMs;

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
    cacheHitConfirmed,
    cacheHitRatio: Math.round(cacheHitRatio * 1000) / 1000,
    fanoutDurationMs,
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
    warmCacheControlSent: false,
    cacheHitConfirmed,
    warmDurationMs: 0,
    totalUsage,
  };
}
