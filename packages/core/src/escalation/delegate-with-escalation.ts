// NOTE: Despite the name "delegateWithEscalation", this function does NOT
// perform status-level tier escalation. Escalation policy lives in
// escalation/policy.ts and is invoked via runWithFallback by the
// lifecycle review-chain handlers. This function only handles transient
// retries (api_error / network_error).

import type { TaskSpec, RunResult, Provider, AgentType } from '../types.js';
import type {
  AttemptRecord,
  InternalRunnerEvent,
  RunStatus,
  TerminationReason,
} from '../providers/runner-types.js';
import type { EventEmitter } from '../events/event-emitter.js';
import type { Session } from '../types/run-result.js';
import { retryableFor } from '../error-codes.js';
import { hasCompletedWork, extractToolName } from '../providers/stall-detector.js';
import { assembleRunResult } from '../providers/assemble-run-result.js';
import { HUMAN_LABEL } from '../lifecycle/stage-labels.js';

function deriveCause(status: RunStatus, errorCode?: string): TerminationReason['cause'] {
  if (errorCode === 'degenerate_exhausted') return 'degenerate_exhausted';
  if (status === 'ok') return 'finished';
  if (status === 'incomplete') return 'incomplete';
  if (status === 'unavailable') return 'error';
  return status as TerminationReason['cause'];
}

export interface DelegateOptions {
  explicitlyPinned?: boolean;
  onProgress?: (event: InternalRunnerEvent) => void;
  /**
   * Absolute Date.now() deadline for the entire task — across retries AND
   * tier fallbacks. Each provider.run gets at most `deadline - Date.now()`
   * as its per-call timeout. When the deadline is hit between calls, the
   * loop breaks and returns the best salvage so far.
   */
  taskDeadlineMs?: number;
  /**
   * External abort signal — when fired (e.g. by the orchestrator's stall
   * watchdog when nothing has progressed for `defaults.stallTimeoutMs`),
   * the in-flight provider.run force-salvages and returns; the retry/
   * fallback loops short-circuit so the user gets *something* back.
   */
  abortSignal?: AbortSignal;
  /**
   * Tier the caller is invoking this delegate for. Forwarded onto the
   * per-attempt `worker_start` runner event so observability can attribute
   * each provider attempt to its assigned tier.
   */
  assignedTier?: AgentType;
  /**
   * Bus for runner-shell and adapter events (`runner_turn_started`,
   * `runner_response_received`, `runner_turn_completed`). When set, the
   * server's VerboseLogChannel + LocalLogSink + TelemetrySink consume them.
   * Forwarded into provider.run as `RunOptions.bus`.
   */
  bus?: EventEmitter;
  /**
   * Batch identifier propagated onto runner events so verbose stderr lines
   * carry the same `batch=...` field as the HTTP-handler breadcrumbs.
   */
  batchId?: string;
  /**
   * Identifies which task within the batch is running. Threaded through to
   * runner events so per-task progress can be tracked separately when a
   * batch has multiple parallel tasks.
   */
  taskIndex?: number;
  /**
   * Lifecycle stage label forwarded to RunInput.stageLabel so the running-
   * headline polling response shows the current stage (e.g. 'Implementing').
   */
  stageLabel?: string;
}

const TRANSIENT_STATUSES: ReadonlySet<string> = new Set(['api_error', 'provider_transport_failure']);
const TIMEOUT_STATUS = 'timeout';
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maxRetriesForStatus(status: string): number {
  if (TRANSIENT_STATUSES.has(status)) return MAX_RETRIES;
  if (status === TIMEOUT_STATUS) return 1;
  return 0;
}

export async function delegateWithEscalation(
  task: TaskSpec,
  chain: Provider[],
  options: DelegateOptions = {},
): Promise<RunResult> {
  if (chain.length === 0) {
    throw new Error('delegateWithEscalation called with empty chain');
  }

  const safeSink: ((event: InternalRunnerEvent) => void) | undefined = options.onProgress
    ? (event) => {
        try {
          options.onProgress!(event);
        } catch {
        }
      }
    : undefined;

  const attempts: { result: RunResult; record: AttemptRecord }[] = [];

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];

    if (i > 0 && safeSink) {
      const prev = attempts[attempts.length - 1].record;
      safeSink({
        kind: 'escalation_start',
        previousProvider: prev.provider,
        previousReason: prev.reason ?? `status=${prev.status}`,
        nextProvider: provider.name,
      });
    }

    const initialPromptLengthChars = 0;
    const initialPromptHash = '';

    let result: RunResult;
    let cumulativeCostUSD = 0;

    for (let attempt = 0; ; attempt++) {
      // Cap per-call timeout at the remaining task-level budget.
      let effectiveTimeoutMs = task.timeoutMs;
      if (options.taskDeadlineMs !== undefined) {
        const remaining = options.taskDeadlineMs - Date.now();
        const remainingClamped = remaining > 0 ? remaining : 1;
        effectiveTimeoutMs =
          effectiveTimeoutMs !== undefined
            ? Math.min(effectiveTimeoutMs, remainingClamped)
            : remainingClamped;
      }

      // v4.4: ProviderConfig.type is one of: 'claude' | 'codex'.
      const cfg = provider.config as { type?: string; model?: string };
      const cfgType = cfg.type ?? 'codex';
      const providerTypeName: 'claude' | 'codex' =
        cfgType === 'claude' ? 'claude' : 'codex';
      safeSink?.({
        kind: 'worker_start',
        model: cfg.model ?? 'unknown',
        providerType: providerTypeName,
        tier: options.assignedTier ?? 'standard',
      });

      const cwd = task.cwd ?? process.cwd();
      const wallClockDeadline = options.taskDeadlineMs ?? (Date.now() + (effectiveTimeoutMs ?? 60 * 60 * 1000));
      const idleStallTimeoutMs = 20 * 60 * 1000;
      const abortCtrl = new AbortController();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) abortCtrl.abort();
        else options.abortSignal.addEventListener('abort', () => abortCtrl.abort(), { once: true });
      }
      const session: Session = provider.openSession({
        cwd,
        wallClockDeadline,
        idleStallTimeoutMs,
        abortSignal: abortCtrl.signal,
        ...(options.bus && { bus: options.bus as unknown as object }),
      });
      try {
        const turn = await session.send(task.prompt, {
          stageLabel: options.stageLabel ?? HUMAN_LABEL.implementing,
        });
        result = assembleRunResult(turn);
      } finally {
        try { await session.close(); } catch { /* idempotent */ }
      }

      const maxRetries = maxRetriesForStatus(result.status);
      if (result.status === 'ok' || maxRetries === 0 || attempt >= maxRetries) break;

      const attemptCost = result.cost?.costUSD ?? result.actualCostUSD ?? 0;
      cumulativeCostUSD += attemptCost;
      if (task.maxCostUSD !== undefined && cumulativeCostUSD >= task.maxCostUSD) break;

      if (options.taskDeadlineMs !== undefined && Date.now() >= options.taskDeadlineMs) break;
      if (options.abortSignal?.aborted) break;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      safeSink?.({ kind: 'retry', attempt: attempt + 1, previousStatus: result.status as RunStatus, delayMs });
      await sleep(delayMs);
    }

    const record: AttemptRecord = {
      provider: provider.name,
      status: result.status as RunStatus,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.cost?.costUSD ?? null,
      initialPromptLengthChars,
      initialPromptHash,
      reason:
        result.status === 'ok'
          ? undefined
          : (result.error || `status=${result.status}`),
    };

    attempts.push({ result, record });

    if (result.status === 'ok') {
      const terminationReason: TerminationReason = {
        cause: 'finished',
        turnsUsed: result.turns,
        hasFileArtifacts: result.filesWritten.length > 0,
        usedShell: result.toolCalls.some(tc => extractToolName(tc) === 'runShell'),
        workerSelfAssessment: result.workerStatus ?? null,
        wasPromoted: false,
      };
      return { ...result, terminationReason, escalationLog: attempts.map((a) => a.record) };
    }

    // Skip the next provider in the fallback chain if the task-level
    // deadline has been hit or the stall watchdog aborted.
    if (options.taskDeadlineMs !== undefined && Date.now() >= options.taskDeadlineMs) {
      break;
    }
    if (options.abortSignal?.aborted) {
      break;
    }

    if (options.explicitlyPinned) {
      return {
        ...result,
        errorCode: result.errorCode ?? result.status,
        retryable: result.retryable ?? retryableFor(result.status),
        escalationLog: attempts.map((a) => a.record),
      };
    }
  }

  const realContentAttempts = attempts.filter((a) => !a.result.outputIsDiagnostic);
  const pool = realContentAttempts.length > 0 ? realContentAttempts : attempts;

  let best = pool[0].result;
  for (const a of pool) {
    if (a.result.output.length > best.output.length) {
      best = a.result;
    }
  }

  // v5: escalation no longer gates on workerSelfAssessment. Annotate is the
  // single point of truth for `completed` (spec §5.7 + §9 M1/M3 fixes).
  // Escalation only records attempts and selects the best one; status flows
  // through unchanged to annotate which makes the final verdict.
  const finalStatus = best.status === 'ok' ? 'incomplete' : best.status;

  const terminationReason: TerminationReason = {
    cause: deriveCause(finalStatus as RunStatus, best.errorCode),
    turnsUsed: best.turns,
    hasFileArtifacts: best.filesWritten.length > 0,
    usedShell: best.toolCalls.some(tc => extractToolName(tc) === 'runShell'),
    workerSelfAssessment: best.workerStatus ?? null,   // truthful read; NOT stamped (M3 fix)
    wasPromoted: false,
  };

  return {
    ...best,
    status: finalStatus,
    terminationReason,
    errorCode: best.errorCode ?? finalStatus,
    retryable: best.retryable ?? retryableFor(finalStatus),
    escalationLog: attempts.map((a) => a.record),
  };
}
