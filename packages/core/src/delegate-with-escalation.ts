import type {
  TaskSpec,
  RunResult,
  RunStatus,
  Provider,
  AttemptRecord,
  ProgressEvent,
  TerminationReason,
} from './types.js';
import { retryableFor } from './error-codes.js';
import { hasCompletedWork, extractToolName } from './runners/supervision.js';

function deriveCause(status: RunStatus, errorCode?: string): TerminationReason['cause'] {
  if (errorCode === 'degenerate_exhausted') return 'degenerate_exhausted';
  if (status === 'ok') return 'finished';
  if (status === 'incomplete') return 'incomplete';
  return status;
}

export interface DelegateOptions {
  explicitlyPinned?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  escalateToProvider?: Provider;
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

  const safeSink: ((event: ProgressEvent) => void) | undefined = options.onProgress
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

      result = await provider.run(task.prompt, {
        tools: task.tools,
        maxTurns: task.maxTurns,
        timeoutMs: task.timeoutMs,
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

    if (options.explicitlyPinned) {
      return {
        ...result,
        errorCode: result.errorCode ?? result.status,
        retryable: result.retryable ?? retryableFor(result.status),
        escalationLog: attempts.map((a) => a.record),
      };
    }
  }

  // Auto-escalation: if single-provider dispatch failed for escalation-eligible
  // reasons (degenerate_exhausted, api_error, network_error), retry with complex.
  const bestResult = attempts[attempts.length - 1].result;
  const cause = deriveCause(bestResult.status, bestResult.errorCode);
  const shouldEscalate =
    !options.explicitlyPinned &&
    chain.length === 1 &&
    options.escalateToProvider !== undefined &&
    (cause === 'degenerate_exhausted' ||
     cause === 'api_error' ||
     cause === 'network_error');

  if (shouldEscalate) {
    const escalationProvider = options.escalateToProvider!;
    safeSink?.({
      kind: 'escalation_start',
      previousProvider: bestResult.status === 'ok' ? 'standard' : chain[0].name,
      previousReason: `cause=${cause}`,
      nextProvider: escalationProvider.name,
    });

    const escalationResult = await escalationProvider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
      expectedCoverage: task.expectedCoverage,
      skipCompletionHeuristic: task.skipCompletionHeuristic,
      parentModel: task.parentModel,
      maxCostUSD: task.maxCostUSD,
      formatConstraints: task.formatConstraints,
      onProgress: safeSink,
    });

    const escalationRecord: AttemptRecord = {
      provider: escalationProvider.name,
      status: escalationResult.status,
      turns: escalationResult.turns,
      inputTokens: escalationResult.usage.inputTokens,
      outputTokens: escalationResult.usage.outputTokens,
      costUSD: escalationResult.usage.costUSD,
      initialPromptLengthChars: 0,
      initialPromptHash: '',
      reason: escalationResult.status === 'ok'
        ? undefined
        : (escalationResult.error || `status=${escalationResult.status}`),
    };

    if (escalationResult.status === 'ok') {
      return {
        ...escalationResult,
        escalationLog: [...attempts.map((a) => a.record), escalationRecord],
      };
    }
    attempts.push({ result: escalationResult, record: escalationRecord });
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
  const outputIsSubstantive =
    best.output.trim().length > 0 && !best.outputIsDiagnostic;
  const finalStatus =
    baseStatus === 'incomplete' &&
    best.workerStatus === 'done' &&
    (best.filesWritten.length > 0 || hasCompletedWork(best.toolCalls)) &&
    outputIsSubstantive
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
