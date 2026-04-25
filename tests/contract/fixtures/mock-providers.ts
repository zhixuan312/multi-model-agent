// Deterministic mock providers for contract tests.
//
// Provider / RunResult shapes inspected from packages/core/src/types.ts on
// 2026-04-24:
//   - Provider has: name, config, run(prompt, options?) => Promise<RunResult>
//   - RunResult required fields: output, status, usage, turns, filesRead,
//     filesWritten, toolCalls, outputIsDiagnostic, escalationLog
//   - Stage-specific optional fields: terminationReason, specReviewStatus,
//     qualityReviewStatus, workerStatus, etc.
//   - Usage: { inputTokens, outputTokens, totalTokens, costUSD | null }

import type {
  Provider,
  ProviderConfig,
  RunResult,
  RunStatus,
  TokenUsage,
  AttemptRecord,
} from '@zhixuan92/multi-model-agent-core';

export type Stage =
  | 'ok'
  | 'incomplete'
  | 'force-salvage'
  | 'max-turns'
  | 'clarification'
  | 'review-rework';

export interface MockProviderOptions {
  stage?: Stage;
  output?: string;
  cost?: number;
  onPrompt?: (prompt: string) => void;
}

const STUB_CONFIG: ProviderConfig = {
  type: 'openai-compatible',
  baseUrl: 'http://mock.local',
  apiKey: 'mock',
  model: 'mock-model',
} as ProviderConfig;

function usage(cost: number | null): TokenUsage {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: cost };
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

function buildOk(opts: MockProviderOptions): RunResult {
  const cost = opts.cost ?? 0.001;
  return {
    output: opts.output ?? 'mocked ok',
    status: 'ok',
    usage: usage(cost),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('ok', 1, cost)],
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

function buildIncomplete(opts: MockProviderOptions): RunResult {
  return {
    output: opts.output ?? 'mock incomplete',
    status: 'incomplete',
    usage: usage(0.001),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [attempt('incomplete', 1, 0.001)],
    durationMs: 0,
    directoriesListed: [],
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

function buildForceSalvage(opts: MockProviderOptions): RunResult {
  return {
    output: opts.output ?? 'mock salvage',
    status: 'degenerate_exhausted',
    usage: usage(0.001),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('degenerate_exhausted', 1, 0.001)],
    durationMs: 0,
    directoriesListed: [],
    terminationReason: {
      cause: 'degenerate_exhausted',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: null,
      wasPromoted: false,
    },
  };
}

function buildMaxTurns(opts: MockProviderOptions): RunResult {
  return {
    output: opts.output ?? 'mock max turns',
    status: 'incomplete',
    usage: usage(0.002),
    turns: 99,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [attempt('incomplete', 99, 0.002)],
    durationMs: 0,
    directoriesListed: [],
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

function buildClarificationNeeded(opts: MockProviderOptions): RunResult {
  return {
    output: opts.output ?? 'needs clarification',
    status: 'brief_too_vague',
    usage: usage(0.0005),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('brief_too_vague', 1, 0.0005)],
    durationMs: 0,
    directoriesListed: [],
    terminationReason: {
      cause: 'brief_too_vague',
      turnsUsed: 1,
      hasFileArtifacts: false,
      usedShell: false,
      workerSelfAssessment: null,
      wasPromoted: false,
    },
  };
}

function buildReviewRework(opts: MockProviderOptions): RunResult {
  return {
    output: opts.output ?? 'needs rework per review',
    status: 'ok',
    usage: usage(0.001),
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [attempt('ok', 1, 0.001)],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    specReviewStatus: 'changes_required',
    qualityReviewStatus: 'changes_required',
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

export function mockProvider(opts: MockProviderOptions): Provider {
  const runner = (): RunResult => {
    const stage = opts.stage ?? 'ok';
    switch (stage) {
      case 'ok': return buildOk(opts as MockProviderOptions & { stage: Stage });
      case 'incomplete': return buildIncomplete(opts as MockProviderOptions & { stage: Stage });
      case 'force-salvage': return buildForceSalvage(opts as MockProviderOptions & { stage: Stage });
      case 'max-turns': return buildMaxTurns(opts as MockProviderOptions & { stage: Stage });
      case 'clarification': return buildClarificationNeeded(opts as MockProviderOptions & { stage: Stage });
      case 'review-rework': return buildReviewRework(opts as MockProviderOptions & { stage: Stage });
    }
  };
  return {
    name: 'mock',
    config: STUB_CONFIG,
    async run(prompt: string): Promise<RunResult> {
      opts.onPrompt?.(prompt);
      return runner();
    },
  };
}

export function capExhaustingProvider(opts: { kind: 'turn' | 'cost' | 'wall_clock'; partialOutput?: string }): Provider {
  return {
    name: `mock-${opts.kind}-cap`,
    config: STUB_CONFIG,
    async run(): Promise<RunResult> {
      const output = opts.partialOutput ?? 'mock cap output';
      if (opts.kind === 'cost') {
        return {
          ...buildIncomplete({ stage: 'incomplete', output }),
          status: 'cost_exceeded',
          capExhausted: 'cost',
          terminationReason: {
            cause: 'cost_exceeded',
            turnsUsed: 1,
            hasFileArtifacts: false,
            usedShell: false,
            workerSelfAssessment: null,
            wasPromoted: false,
          },
        };
      }
      if (opts.kind === 'wall_clock') {
        return {
          ...buildIncomplete({ stage: 'incomplete', output }),
          status: 'timeout',
          capExhausted: 'wall_clock',
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
      return {
        ...buildMaxTurns({ stage: 'max-turns', output }),
        capExhausted: 'turn',
      };
    },
  };
}

export function clarificationProvider(opts: { proposedInterpretation: string }): Provider {
  return {
    name: 'mock-clarification',
    config: STUB_CONFIG,
    async run(): Promise<RunResult> {
      return {
        ...buildClarificationNeeded({ stage: 'clarification', output: opts.proposedInterpretation }),
        lifecycleClarificationRequested: true,
      };
    },
  };
}

export function throwingProvider(err: Error): Provider {
  return {
    name: 'mock-throw',
    config: STUB_CONFIG,
    async run(): Promise<RunResult> {
      throw err;
    },
  };
}

export function failProvider(message = 'mocked failure'): Provider {
  return throwingProvider(new Error(message));
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
