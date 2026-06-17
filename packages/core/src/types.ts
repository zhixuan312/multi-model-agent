// Public type barrel. Matches spec architecture.md `types/` slot — the
// real declarations live in `types/{stage-stats,task-spec,config,run-result}.ts`,
// each focused on one cohesive group. This file is the entry point so
// existing consumers can keep importing from `'../types.js'` unchanged.

export type {
  ReviewVerdict,
  StageName,
  RawStageStats,
  StageStatsMap,
} from './types/stage-stats.js';

export type {
  ToolMode,
  AgentType,
  Effort,
  CostTier,
  WorkerStatus,
  FormatConstraints,
  TaskSpec,
} from './types/task-spec.js';

export type { SandboxPolicy } from './unified/type-registry.js';

export type {
  AgentConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  ProviderConfig,
  ResearchConfig,
  MultiModelConfig,
} from './types/config.js';

export type {
  RunResult,
  RuntimeRunResult,
  Provider,
} from './types/run-result.js';

// `ErrorCode` lives in `error-codes.ts` next to its Zod schema; re-exported
// here for the same reason `RunResult` lives in `types/run-result.ts`: every
// caller importing the type set should be able to grab it from one place.
export type { ErrorCode } from './error-codes.js';

