// Public type barrel. Matches spec architecture.md `types/` slot — the
// real declarations live in `types/{task-spec,config,run-result}.ts`,
// each focused on one cohesive group. This file is the entry point so
// existing consumers can keep importing from `'../types.js'` unchanged.


export type {
  AgentType,
  Effort,
  CostTier,
  WorkerStatus,
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
  Provider,
} from './types/run-result.js';

// `ErrorCode` lives in `error-codes.ts` next to its Zod schema; re-exported
// here so every caller importing the type set can grab it from one place.
export type { ErrorCode } from './error-codes.js';

