// Deterministic mock providers for contract tests.
//
// Provider / RuntimeRunResult shapes inspected from packages/core/src/types/run-result.ts:
//   - Provider has: name, config, openSession(opts) => Session
//   - RuntimeRunResult required fields: output, status, usage, actualCostUSD, turns,
//     filesWritten, escalationLog
//   - Optional fields: terminationReason, workerStatus, etc.
//   - Usage: { inputTokens, outputTokens, cachedReadTokens, cachedNonReadTokens }

import type {
  Provider,
  ProviderConfig,
  TokenUsage,
} from '@zhixuan92/multi-model-agent-core';
import type { WorkerStatus } from '../../../packages/core/src/types/task-spec.js';
import type { Session, SessionOpts, TurnResult } from '../../../packages/core/src/types/run-result.js';
import type { RuntimeRunResult, RunStatus } from './runtime-run-result.js';

/** Build a Session whose `send()` invokes the same RuntimeRunResult-producing
 *  runner every mock provider uses, projected down to the TurnResult the
 *  provider-runner contract actually returns. */
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
    usedShell: rr.usedShell ?? false,
    toolCalls: [],
    ...(rr.errorCode && { errorCode: rr.errorCode }),
    ...(rr.error && { errorMessage: rr.error }),
    // No `workerSelfAssessment` spread here. `TurnResult` declares eleven keys (pinned by
    // `tests/providers/turn-result-shape.test.ts`) and that is not one of them — a spread bypasses
    // excess-property checking, so the mock was quietly handing the pipeline a twelfth field that
    // no production code reads. Every scenario that set `workerStatus` believed it was driving
    // worker self-assessment and was driving nothing.
  };
}

function statusToTermination(
  status: RuntimeRunResult['status'],
): TurnResult['terminationReason'] {
  switch (status) {
    case 'ok': return 'ok';
    case 'timeout': return 'time_exceeded';
    // 'incomplete' means the worker used up its turn budget without a
    // technical failure — the underlying provider turn itself completed
    // normally, so it maps to 'ok' at this raw session-level signal.
    case 'incomplete': return 'ok';
    case 'error':
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

/**
 * The scenarios a mock provider can play.
 *
 * `'review-rework'` and `'slow'` used to sit here. Once the inert fields were stripped from
 * `RuntimeRunResult`, both builders were `buildOk` with a different default output string — and
 * `'slow'` never made anything slow in the first place: `MockProviderOptions.delayMs` is what the
 * runner awaits. Neither stage had ever been passed by a test.
 */
export type Stage =
  | 'ok'
  | 'incomplete'
  | 'max-turns'   // reached through `capProvider`, not by a `stage:` option
  | 'hang';       // never-resolves send() — for shutdown-drain test

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

function buildOk(opts: MockProviderOptions): RuntimeRunResult {
  const cost = opts.cost ?? 0.001;
  return {
    output: opts.output ?? 'mocked ok',
    status: 'ok',
    usage: usage(cost),
    actualCostUSD: cost,
    turns: 1,
    filesWritten: [],
    durationMs: 0,
  };
}

function buildIncomplete(opts: MockProviderOptions): RuntimeRunResult {
  return {
    output: opts.output ?? 'mock incomplete',
    status: 'incomplete',
    usage: usage(0.001),
    actualCostUSD: 0.001,
    turns: 1,
    filesWritten: [],
    durationMs: 0,
  };
}

function buildMaxTurns(opts: MockProviderOptions): RuntimeRunResult {
  return {
    output: opts.output ?? 'mock max turns',
    status: 'incomplete',
    usage: usage(0.002),
    actualCostUSD: 0.002,
    turns: 99,
    filesWritten: [],
    durationMs: 0,
  };
}

function buildFromSequenceItem(item: SequenceItem): RuntimeRunResult {
  const cost = 0.001;
  return {
    output: item.output ?? 'mocked sequence item',
    status: item.status ?? 'ok',
    usage: usage(cost),
    actualCostUSD: cost,
    turns: 1,
    filesWritten: item.filesWritten ?? [],
    durationMs: 0,
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
      case 'hang':
        // openSession() branches on stage === 'hang' before ever constructing
        // the runOnce() closure that calls this runner() — unreachable in practice.
        throw new Error('runner() should not be invoked for stage "hang"');
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
    openSession(sessionOpts: SessionOpts) {
      opts.onOpen?.();
      const stage = opts.stage ?? 'ok';
      if (stage === 'hang') {
        const inner = {
          getSessionId(): string | null { return null; },
          async send(): Promise<TurnResult> {
            return new Promise<TurnResult>((_, reject) => {
              const signal = sessionOpts?.abortSignal;
              if (!signal) return;
              // `AbortSignal`'s `abort` event fires (at most) once. Cancellation
              // may already have been requested — and the signal already fired —
              // BEFORE this session's `send()` is reached (e.g. while a
              // preceding preprocessor step was still running): registering a
              // ONE-SHOT listener at that point would never see the past event
              // and would hang forever. Check the already-aborted case first.
              if (signal.aborted) { reject(new Error('aborted')); return; }
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
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
      };
    }
    return buildMaxTurns({ stage: 'max-turns', output });
  };
  return {
    name: `mock-${opts.kind}-cap`,
    config: STUB_CONFIG,
    openSession: makeSessionFactory(run),
  };
}

export function throwingProvider(err: Error): Provider {
  return {
    name: 'mock-throw',
    config: STUB_CONFIG,
    openSession: (_opts: SessionOpts): Session => ({
      async send(): Promise<TurnResult> { throw err; },
      async close(): Promise<void> { /* no-op */ },
      getSessionId(): string | null { return null; },
    }),
  };
}

export function guardNoNetwork(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`contract test attempted network call: ${url}`);
  }) as typeof globalThis.fetch;
}
