// Provider configs are the runtime shape passed to provider factories
// (carry costTier, which the agent schema does not). No Zod twin exists,
// so they stay hand-written here. The validated config shapes
// (MultiModelConfig / AgentConfig / ResearchConfig) are inferred from
// config/schema.ts and re-exported below.
import type { Effort, CostTier } from './task-spec.js';

export interface CodexProviderConfig { type: 'codex'; model: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeProviderConfig { type: 'claude'; model: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig

export type { MultiModelConfig, AgentConfig, ResearchConfig } from '../config/schema.js';
