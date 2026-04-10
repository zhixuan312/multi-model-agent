import { z } from 'zod';
import type {
  CodexProviderConfig,
  ClaudeProviderConfig,
  MultiModelConfig,
  OpenAICompatibleProviderConfig,
  ProviderConfig,
} from '../types.js';

// === Per-provider Zod schemas ===

const effortSchema = z.enum(['none', 'low', 'medium', 'high']);
const costTierSchema = z.enum(['free', 'low', 'medium', 'high']);
const hostedToolsSchema = z.array(z.enum(['web_search', 'image_generation', 'code_interpreter']));
const sandboxPolicySchema = z.enum(['none', 'cwd-only']).optional();
// Per-million-token pricing for cost computation. Must be non-negative; zero
// is allowed (free providers can set both rates to 0 to get a deterministic
// costUSD: 0 instead of null).
const tokenCostSchema = z.number().nonnegative().finite().optional();

export const codexProviderConfigSchema = z.object({
  type: z.literal('codex'),
  model: z.string(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
  inputCostPerMTok: tokenCostSchema,
  outputCostPerMTok: tokenCostSchema,
  inputTokenSoftLimit: z.number().int().positive().optional(),
});

export const claudeProviderConfigSchema = z.object({
  type: z.literal('claude'),
  model: z.string(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
  inputCostPerMTok: tokenCostSchema,
  outputCostPerMTok: tokenCostSchema,
  inputTokenSoftLimit: z.number().int().positive().optional(),
});

export const openAICompatibleProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  model: z.string(),
  baseUrl: z.string().min(1, 'baseUrl is required for openai-compatible providers'),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
  inputCostPerMTok: tokenCostSchema,
  outputCostPerMTok: tokenCostSchema,
  inputTokenSoftLimit: z.number().int().positive().optional(),
});

export const providerConfigSchema = z.discriminatedUnion('type', [
  codexProviderConfigSchema,
  claudeProviderConfigSchema,
  openAICompatibleProviderConfigSchema,
]);

// === MultiModelConfig schema ===

const defaultsSchema = z.object({
  maxTurns: z.number().int().positive().default(200),
  timeoutMs: z.number().int().positive().default(600_000),
  tools: z.enum(['none', 'full']).default('full'),
}).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const }));

export const multiModelConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema).default({}),
  defaults: defaultsSchema,
});

export interface ParsedConfigSuccess {
  config: MultiModelConfig
  success: true
}

export interface ParsedConfigFailure {
  success: false
  error: string
}

export type ParseConfigResult = ParsedConfigSuccess | ParsedConfigFailure

/**
 * Parse a raw config object — validates schema, no side effects.
 * Does NOT load from disk.
 */
export function parseConfig(raw: unknown): MultiModelConfig {
  return multiModelConfigSchema.parse(raw);
}
