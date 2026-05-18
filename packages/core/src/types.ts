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
  SandboxPolicy,
  AgentType,
  Effort,
  CostTier,
  WorkerStatus,
  FormatConstraints,
  TaskSpec,
} from './types/task-spec.js';

export type {
  AgentConfig,
  FallbackOverride,
  CodexProviderConfig,
  ClaudeProviderConfig,
  ProviderConfig,
  ResearchConfig,
  MultiModelConfig,
} from './types/config.js';

export type {
  Commit,
  RunResult,
  RuntimeRunResult,
  ReviewPromptParts,
  CacheHints,
  ReviewRunOptions,
  Provider,
} from './types/run-result.js';

// `ErrorCode` lives in `error-codes.ts` next to its Zod schema; re-exported
// here for the same reason `RunResult` lives in `types/run-result.ts`: every
// caller importing the type set should be able to grab it from one place.
export type { ErrorCode } from './error-codes.js';

// A11.2 — per-task cost surface on RunResult.cost (CostBreakdown):
//   costUSD              : sum of every stage's costUSD — the canonical total
//   costDeltaVsMainUSD  : delta vs estimated main-tier cost
// The three fields below are back-compat aliases on the task_completed event
// envelope (terminal-handlers.ts). All three resolve to the same value at
// emit-time; the aliases exist so existing callers (expecting costUSD or
// totalCostUSD) and new callers (expecting actualCostUSD) both receive the
// correct figure without migration.
// @deprecated use costUSD directly; aliases will be removed in a future release
export interface PerTaskCostSlots {
  /** Canonical total cost for this task (sum of all stage costs). */
  actualCostUSD: number | null;
  /** @deprecated alias for actualCostUSD */
  costUSD: number | null;
  /** @deprecated alias for actualCostUSD */
  totalCostUSD: number | null;
  /** Delta vs estimated main-tier cost (from CostBreakdown.costDeltaVsMainUSD). */
  costDeltaVsMainUSD: number | null;
}
