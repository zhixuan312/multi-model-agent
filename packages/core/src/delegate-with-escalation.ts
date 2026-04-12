import type {
  TaskSpec,
  RunResult,
  Provider,
  AttemptRecord,
  ProgressEvent,
} from './types.js';

export interface DelegateOptions {
  explicitlyPinned?: boolean;
  onProgress?: (event: ProgressEvent) => void;
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

    const result = await provider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
      expectedCoverage: task.expectedCoverage,
      skipCompletionHeuristic: task.skipCompletionHeuristic,
      includeProgressTrace: task.includeProgressTrace,
      parentModel: task.parentModel,
      onProgress: safeSink,
      onInitialRequest: (meta) => {
        initialPromptLengthChars = meta.lengthChars;
        initialPromptHash = meta.sha256;
      },
    });

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
      ...(result.progressTrace && { progressTrace: result.progressTrace }),
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

  return {
    ...best,
    status: best.status === 'ok' ? 'incomplete' : best.status,
    escalationLog: attempts.map((a) => a.record),
  };
}
