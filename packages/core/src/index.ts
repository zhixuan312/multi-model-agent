// Config
export { loadConfigFromFile } from './config/load.js';
export { parseConfig, multiModelConfigSchema } from './config/schema.js';

// Types (re-export all)
export type {
  Tier,
  Capability,
  ToolMode,
  SandboxPolicy,
  Effort,
  CostTier,
  RunStatus,
  TaskSpec,
  ProviderConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  OpenAICompatibleProviderConfig,
  MultiModelConfig,
  TokenUsage,
  RunResult,
  Provider,
  RunOptions,
  EligibilityFailureCheck,
  EligibilityFailure,
  ProviderEligibility,
} from './types.js';

// Provider
export { createProvider } from './provider.js';

// Run tasks
export { runTasks } from './run-tasks.js';

// Routing helpers
export { getBaseCapabilities } from './routing/capabilities.js';
export { resolveTaskCapabilities } from './routing/resolve-task-capabilities.js';
export { findModelProfile, getEffectiveCostTier } from './routing/model-profiles.js';
export { selectProviderForTask } from './routing/select-provider-for-task.js';
export { getProviderEligibility } from './routing/get-provider-eligibility.js';
