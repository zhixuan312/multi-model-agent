// Per-protocol provider config + top-level MultiModelConfig + research
// config. Imported by config/load.ts, config/schema.ts, config/model-profiles.ts,
// and many runtime callers. Matches spec architecture.md `types/` slot
// (configuration is cross-cutting; the closed-enum surface lives here).
import type { RunStatus } from '../providers/runner-types.js';
import type { AgentType, SandboxPolicy, ToolMode, Effort, CostTier } from './task-spec.js';

export interface AgentConfig {
  type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex'
  model: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  inputTokenSoftLimit?: number
}

export interface FallbackOverride {
  role: 'implementer' | 'specReviewer' | 'qualityReviewer' | 'diffReviewer';
  loop: 'spec' | 'quality' | 'diff';
  attempt: number;
  assigned: AgentType;
  used: AgentType | 'none';
  reason: 'transport_failure' | 'not_configured' | 'reviewer_separation_unsatisfiable';
  triggeringStatus?: RunStatus;
  bothUnavailable: boolean;
}

export interface CodexProviderConfig { type: 'codex'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeProviderConfig { type: 'claude'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeCompatibleProviderConfig { type: 'claude-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface OpenAICompatibleProviderConfig { type: 'openai-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig | ClaudeCompatibleProviderConfig | OpenAICompatibleProviderConfig

export interface ResearchConfig {
  brave: {
    apiKeys: string[]
    timeoutMs: number
    maxResultsPerQuery: number
    perCallBackoffMs: number
  }
  fetch: {
    maxRedirects: number
    connectTimeoutMs: number
    totalDeadlineMs: number
    maxBodyBytes: number
    allowPrivateNetwork: boolean
  }
  builtinAdapters: {
    arxiv: boolean
    semanticScholar: boolean
    githubSearch: boolean
    genericRss: boolean
  }
  userSources: string[]
  fetchAllowlistExtra: string[]
}

export interface MultiModelConfig {
  agents: { standard: AgentConfig; complex: AgentConfig }
  defaults: { timeoutMs: number; stallTimeoutMs: number; maxCostUSD: number; tools: ToolMode; sandboxPolicy: SandboxPolicy; largeResponseThresholdChars?: number; mainModel?: string }
  diagnostics?: { log: boolean; logDir?: string; verbose?: boolean }
  server: {
    bind: string
    port: number
    auth: { tokenFile: string }
    limits: { maxBodyBytes: number; batchTtlMs: number; idleProjectTimeoutMs: number; projectCap: number; maxBatchCacheSize: number; maxContextBlockBytes: number; maxContextBlocksPerProject: number; shutdownDrainMs: number }
    autoUpdateSkills: boolean
  }
  research: ResearchConfig
}
