// Deterministic mock providers for contract tests.

import type {
  Provider,
  ProviderConfig,
  RuntimeRunResult,
  RunStatus,
  TokenUsage,
  AttemptRecord,
  WorkerStatus,
} from '@zhixuan92/multi-model-agent-core';
import type { Session, SessionOpts, TurnResult } from '../../../packages/core/src/types/run-result.js';
import type { RunnerAdapter } from '../../helpers/test-harness.js';

/** v4.4: build a Session whose `send()` invokes the same RuntimeRunResult-producing
 *  runner the legacy `provider.run()` path uses. Lets every mock provider
 *  satisfy both APIs from a single source of truth — until Task 24 drops
 *  the legacy run shim entirely. */
function runResultToTurnResult(rr: RuntimeRunResult): TurnResult {
  // Each session.send() represents one model session whose internal turn
  // count (claude-agent-sdk reports num_turns, codex CLI reports turns)
  // is what TurnResult.turns carries. The mock simply forwards rr.turns.
  return {
    output: rr.output ?? '',
    usage: rr.usage,
    filesWritten: rr.filesWritten ?? [],
    turns: rr.turns ?? 1,
    durationMs: rr.durationMs ?? 0,
    costUSD: rr.actualCostUSD ?? rr.cost?.costUSD ?? null,
    terminationReason: statusToTermination(rr.status),
    ...(rr.errorCode && { errorCode: rr.errorCode }),
    ...(rr.error && { errorMessage: rr.error }),
    ...(rr.workerStatus && { workerSelfAssessment: rr.workerStatus }),
  };
}

function statusToTermination(
  status: RuntimeRunResult['status'],
): TurnResult['terminationReason'] {
  switch (status) {
    case 'ok': return 'ok';
    case 'timeout': return 'time_exceeded';
    case 'incomplete': return 'cap_exhausted';
    case 'error':
    case 'auth_error':
    case 'rate_limited':
    default:
      return 'error';
  }
}

function makeSessionFactory(runner: (prompt: string) => Promise<RuntimeRunResult>): (opts: SessionOpts) => Session {
  return (_opts: SessionOpts): Session => ({
    async send(instruction: string): Promise<TurnResult> {
      const rr = await runner(instruction);
      return runResultToTurnResult(rr);
    },
    async close(): Promise<void> { /* no-op */ },
    getSessionId(): string | null { return null; },
  });
}

export type Stage =
  | 'ok'
  | 'incomplete'
  | 'max-turns'
  | 'review-rework'
  | 'slow'
  | 'hang';   // never-resolves send() — for shutdown-drain test

export interface SequenceItem {
  status?: RunStatus;
  output?: string;
  filesWritten?: string[];
  workerStatus?: WorkerStatus;
}

export interface MockProviderOptions {
  stage?: Stage;
  output?: string;
  cost?: number;
  onPrompt?: (prompt: string) => void;
  sequence?: SequenceItem[];
  delayMs?: number;
  /** Called once whenever the mock provider's openSession() is invoked. */
  onOpen?: () => void;
  /** Called once whenever the returned Session's close() is invoked. */
  onClose?: () => void;
}

const STUB_CONFIG: ProviderConfig = {
  type: 'codex',
  baseUrl: 'http://mock.local',
  apiKey: 'mock',
  model: 'mock-model',
} as ProviderConfig;

function usage(_cost: number | null): TokenUsage {
  return { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 };
}

function attempt(status: RunStatus, turns: number, cost: number | null): AttemptRecord {
  return {
    provider: 'mock',
    status,
    turns,
    inputTokens: 10,
    outputTokens: 20,
    costUSD: cost,
    initialPromptLengthChars: 0,
    initialPromptHash: '',
  };
}

function buildOk(opts: MockProviderOptions): RuntimeRunResult {
  const cost = opts.cost ?? 0.001;
  return {
    output: opts.output ?? 'mocked ok',
    status: 'ok',
    usage: usage(cost),
    turns: 1,
    filesWritten: [],
    escalationLog: [attempt('ok', 1, cost)],
    durationMs: 0,
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function buildIncomplete(opts: MockProviderOptions): RuntimeRunResult {
  return {
    output: opts.output ?? 'mock incomplete',
    status: 'incomplete',
    usage: usage(0.001),
    turns: 1,
    filesWritten: [],
    escalationLog: [attempt('incomplete', 1, 0.001)],
    durationMs: 0,
    terminationReason: {
      cause: 'incomplete',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: null,
      wasPromoted: false,
    },
  };
}

function buildMaxTurns(opts: MockProviderOptions): RuntimeRunResult {
  return {
    output: opts.output ?? 'mock max turns',
    status: 'incomplete',
    usage: usage(0.002),
    turns: 99,
    filesWritten: [],
    escalationLog: [attempt('incomplete', 99, 0.002)],
    durationMs: 0,
    terminationReason: {
      cause: 'incomplete',
      turnsUsed: 99,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: null,
      wasPromoted: false,
    },
  };
}

function buildReviewRework(opts: MockProviderOptions): RuntimeRunResult {
  return {
    output: opts.output ?? 'needs rework per review',
    status: 'ok',
    usage: usage(0.001),
    turns: 1,
    filesWritten: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('ok', 1, 0.001)],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function buildSlow(opts: MockProviderOptions & { suppressProgress?: boolean }): RuntimeRunResult {
  return {
    output: opts.output ?? 'mocked slow ok',
    status: 'ok',
    usage: usage(opts.cost ?? 0.001),
    turns: 1,
    filesWritten: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('ok', 1, opts.cost ?? 0.001)],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: {
      cause: 'finished',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: 'done',
      wasPromoted: false,
    },
  };
}

function buildFromSequenceItem(item: SequenceItem): RuntimeRunResult {
  const cost = 0.001;
  return {
    output: item.output ?? 'mocked sequence item',
    status: item.status ?? 'ok',
    usage: usage(cost),
    turns: 1,
    filesWritten: item.filesWritten ?? [],
    escalationLog: [attempt(item.status ?? 'ok', 1, cost)],
    durationMs: 0,
    workerStatus: item.workerStatus ?? 'done',
    terminationReason: {
      cause: item.status === 'ok' ? 'finished' : item.status ?? 'finished',
      turnsUsed: 1,
      hasFileArtifacts: (item.filesWritten?.length ?? 0) > 0,
      usedShell: false,
      workerSelfAssessment: item.workerStatus ?? 'done',
      wasPromoted: false,
    },
  };
}

export function mockProvider(opts: MockProviderOptions): Provider {
  let seqIdx = 0;

  const runner = (): RuntimeRunResult => {
    const stage = opts.stage ?? 'ok';
    switch (stage) {
      case 'ok': return buildOk(opts as MockProviderOptions & { stage: Stage });
      case 'incomplete': return buildIncomplete(opts as MockProviderOptions & { stage: Stage });
      case 'max-turns': return buildMaxTurns(opts as MockProviderOptions & { stage: Stage });
      case 'review-rework': return buildReviewRework(opts as MockProviderOptions & { stage: Stage });
      case 'slow': return buildSlow(opts as MockProviderOptions & { stage: Stage; suppressProgress?: boolean });
    }
  };
  const runOnce = async (prompt: string): Promise<RuntimeRunResult> => {
    opts.onPrompt?.(prompt);
    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    if (opts.sequence) {
      const item = opts.sequence[seqIdx] ?? opts.sequence[opts.sequence.length - 1];
      seqIdx++;
      return buildFromSequenceItem(item);
    }
    return runner();
  };
  return {
    name: 'mock',
    config: STUB_CONFIG,
    run: runOnce,
    openSession(sessionOpts: SessionOpts) {
      opts.onOpen?.();
      const stage = opts.stage ?? 'ok';
      if (stage === 'hang') {
        const inner = {
          getSessionId(): string | null { return null; },
          async send(): Promise<TurnResult> {
            return new Promise<TurnResult>((_, reject) => {
              if (sessionOpts?.abortSignal) {
                sessionOpts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
              }
            });
          },
          async close(): Promise<void> { /* no-op */ },
        };
        const origClose = inner.close.bind(inner);
        return {
          send: inner.send.bind(inner),
          async close() {
            try {
              await origClose();
            } finally {
              opts.onClose?.();
            }
          },
          getSessionId: inner.getSessionId.bind(inner),
        };
      }
      const inner = makeSessionFactory(runOnce)(sessionOpts);
      const origClose = inner.close.bind(inner);
      return {
        send: inner.send.bind(inner),
        async close() {
          try {
            await origClose();
          } finally {
            opts.onClose?.();
          }
        },
        getSessionId: inner.getSessionId.bind(inner),
      };
    },
  };
}

export function capExhaustingProvider(opts: { kind: 'turn' | 'cost' | 'wall_clock'; partialOutput?: string }): Provider {
  const run = async (): Promise<RuntimeRunResult> => {
    const output = opts.partialOutput ?? 'mock cap output';
    if (opts.kind === 'wall_clock') {
      return {
        ...buildIncomplete({ stage: 'incomplete', output }),
        status: 'timeout',
        terminationReason: {
          cause: 'timeout',
          turnsUsed: 1,
          hasFileArtifacts: false,
          usedShell: false,
          workerSelfAssessment: null,
          wasPromoted: false,
        },
      };
    }
    return buildMaxTurns({ stage: 'max-turns', output });
  };
  return {
    name: `mock-${opts.kind}-cap`,
    config: STUB_CONFIG,
    run,
    openSession: makeSessionFactory(run),
  };
}

export function throwingProvider(err: Error): Provider {
  const run = async (): Promise<RuntimeRunResult> => { throw err; };
  return {
    name: 'mock-throw',
    config: STUB_CONFIG,
    run,
    openSession: (_opts: SessionOpts): Session => ({
      async send(): Promise<TurnResult> { throw err; },
      async close(): Promise<void> { /* no-op */ },
      getSessionId(): string | null { return null; },
    }),
  };
}

export interface FailProviderOptions {
  status?: RunStatus;
  errorCode?: string;
}

export function failProvider(messageOrOpts: string | FailProviderOptions = 'mocked failure'): Provider {
  const opts: FailProviderOptions = typeof messageOrOpts === 'string'
    ? { status: 'error', errorCode: messageOrOpts }
    : messageOrOpts;
  if (opts.status && opts.status !== 'ok') {
    const statusFinal: RunStatus = opts.status;
    const run = async (): Promise<RuntimeRunResult> => ({
      output: `failure: ${opts.errorCode ?? statusFinal}`,
      status: statusFinal,
      usage: usage(null),
      turns: 1,
      filesWritten: [],
      escalationLog: [attempt(statusFinal, 1, null)],
      durationMs: 0,
      workerStatus: 'failed',
      terminationReason: {
        cause: statusFinal,
        turnsUsed: 1,
        hasFileArtifacts: false,
        usedShell: false,
        workerSelfAssessment: 'failed',
        wasPromoted: false,
      },
      structuredError: { code: opts.errorCode ?? 'sdk_execution_error', message: opts.errorCode ?? statusFinal },
    });
    return {
      name: 'mock-fail',
      config: STUB_CONFIG,
      run,
      openSession: makeSessionFactory(run),
    };
  }
  const err = new Error(typeof messageOrOpts === 'string' ? messageOrOpts : 'mocked failure');
  const run = async (): Promise<RuntimeRunResult> => { throw err; };
  return {
    name: 'mock-throw',
    config: STUB_CONFIG,
    run,
    openSession: (_opts: SessionOpts): Session => ({
      async send(): Promise<TurnResult> { throw err; },
      async close(): Promise<void> { /* no-op */ },
      getSessionId(): string | null { return null; },
    }),
  };
}

export function mockAdapter(opts: {
  turns: Array<{ assistantText: string; toolCalls: { name: string; input: unknown }[] }>;
  usage?: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
  throwOnTurn?: Error;
}): RunnerAdapter {
  let i = 0;
  return {
    providerType: 'claude',
    async turn() {
      if (opts.throwOnTurn) throw opts.throwOnTurn;
      const t = opts.turns[i++] ?? { assistantText: '', toolCalls: [] };
      return {
        assistantText: t.assistantText,
        toolCalls: t.toolCalls,
        usage: opts.usage ?? { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        finishReason: t.toolCalls.length > 0 ? 'tool_use' as const : 'stop' as const,
      };
    },
  };
}

// Patches global fetch so any outbound network call from a contract test is
// an immediate, loud failure. Intentionally has no restore — contract tests
// should never go to the network, full stop.
export function guardNoNetwork(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`contract test attempted network call: ${url}`);
  }) as typeof globalThis.fetch;
}
