// NOTE: Despite the name "delegateWithEscalation", this function NO LONGER
// performs status-level tier escalation as of 3.5.0. Escalation policy is
// owned by reviewed-lifecycle.ts via runWithFallback (escalation/policy.ts).
// This function only handles transient retries (api_error / network_error).
// Rename to delegateWithRetries deferred to 3.6.0.

import type { TaskSpec, RunResult, Provider } from './types.js';
import type {
  AttemptRecord,
  InternalRunnerEvent,
  RunStatus,
  TerminationReason,
} from './runners/types.js';
import { retryableFor } from './error-codes.js';
import { hasCompletedWork, extractToolName } from './runners/supervision.js';

function deriveCause(status: RunStatus, errorCode?: string): TerminationReason['cause'] {
  if (errorCode === 'degenerate_exhausted') return 'degenerate_exhausted';
  if (status === 'ok') return 'finished';
  if (status === 'incomplete') return 'incomplete';
  if (status === 'unavailable') return 'error';
  return status;
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
}

const TRANSIENT_STATUSES: ReadonlySet<string> = new Set(['api_error', 'network_error']);
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

    let initialPromptLengthChars = 0;
    let initialPromptHash = '';

    let result: RunResult;
    let cumulativeCostUSD = 0;

    for (let attempt = 0; ; attempt++) {
      const adjustedMaxCostUSD =
        task.maxCostUSD !== undefined ? Math.max(0, task.maxCostUSD - cumulativeCostUSD) : undefined;

      // Cap per-call timeout at the remaining task-level budget. When the
      // deadline is in the past, force a 1ms timeout so the runner returns
      // immediately with whatever salvage it has — synthesized into a
      // task_wall_clock outcome below.
      let effectiveTimeoutMs = task.timeoutMs;
      if (options.taskDeadlineMs !== undefined) {
        const remaining = options.taskDeadlineMs - Date.now();
        const remainingClamped = remaining > 0 ? remaining : 1;
        effectiveTimeoutMs =
          effectiveTimeoutMs !== undefined
            ? Math.min(effectiveTimeoutMs, remainingClamped)
            : remainingClamped;
      }

      result = await provider.run(task.prompt, {
        tools: task.tools,
        timeoutMs: effectiveTimeoutMs,
        abortSignal: options.abortSignal,
        cwd: task.cwd,
        effort: task.effort,
        sandboxPolicy: task.sandboxPolicy,
        expectedCoverage: task.expectedCoverage,
        skipCompletionHeuristic: task.skipCompletionHeuristic,
        parentModel: task.parentModel,
        maxCostUSD: adjustedMaxCostUSD,
        formatConstraints: task.formatConstraints,
        onProgress: safeSink,
        onInitialRequest: (meta) => {
          initialPromptLengthChars = meta.lengthChars;
          initialPromptHash = meta.sha256;
        },
      });

      const maxRetries = maxRetriesForStatus(result.status);
      if (result.status === 'ok' || maxRetries === 0 || attempt >= maxRetries) break;

      const attemptCost = result.usage.costUSD ?? 0;
      cumulativeCostUSD += attemptCost;
      if (task.maxCostUSD !== undefined && cumulativeCostUSD >= task.maxCostUSD) break;

      // Don't burn the retry budget on a doomed call: if the task-level
      // deadline is already past or the stall watchdog aborted, stop trying.
      if (options.taskDeadlineMs !== undefined && Date.now() >= options.taskDeadlineMs) break;
      if (options.abortSignal?.aborted) break;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      safeSink?.({ kind: 'retry', attempt: attempt + 1, previousStatus: result.status, delayMs });
      await sleep(delayMs);
    }

    const record: AttemptRecord = {
      provider: provider.name,
      status: result.status,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.usage.costUSD,
      initialPromptLengthChars,
      initialPromptHash,
      reason:
        result.status === 'ok'
          ? undefined
          : (result.error || `status=${result.status}`),
    };

    attempts.push({ result, record });

    if (result.status === 'ok') {
      return {
        ...result,
        escalationLog: attempts.map((a) => a.record),
      };
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

  const baseStatus = best.status === 'ok' ? 'incomplete' : best.status;

  // C2: Promote incomplete → ok when agent self-assessed as done AND produced work artifacts
  // OR verified with shell (ran tests/builds) even without writing files
  const outputIsSubstantive =
    best.output.trim().length > 0 && !best.outputIsDiagnostic;
  const hasShellVerification = best.toolCalls.some(tc => extractToolName(tc) === 'runShell');
  const finalStatus =
    baseStatus === 'incomplete' &&
    best.workerStatus === 'done' &&
    outputIsSubstantive &&
    (best.filesWritten.length > 0 || hasCompletedWork(best.toolCalls) || hasShellVerification)
      ? 'ok'
      : baseStatus;

  const wasPromoted = finalStatus === 'ok' && baseStatus === 'incomplete';
  const terminationReason: TerminationReason = {
    cause: deriveCause(finalStatus, best.errorCode),
    turnsUsed: best.turns,
    hasFileArtifacts: best.filesWritten.length > 0,
    usedShell: best.toolCalls.some(tc => extractToolName(tc) === 'runShell'),
    workerSelfAssessment: best.workerStatus ?? null,
    wasPromoted,
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
