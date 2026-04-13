import { z } from 'zod';
import type {
  MultiModelConfig,
} from '../types.js';

// === Shared field schemas ===

const effortSchema = z.enum(['none', 'low', 'medium', 'high']);
const hostedToolsSchema = z.array(z.enum(['web_search', 'image_generation', 'code_interpreter']));
const openAICompatibleHostedToolsSchema = z.array(z.enum(['web_search']));
const sandboxPolicySchema = z.enum(['none', 'cwd-only']).optional();
// Per-million-token pricing for cost computation. Must be non-negative; zero
// is allowed (free agents can set both rates to 0 to get a deterministic
// costUSD: 0 instead of null).
const tokenCostSchema = z.number().nonnegative().finite().optional();

const capabilitiesSchema = z.array(z.enum(['web_search', 'web_fetch'])).optional();

const baseAgentFields = {
  model: z.string().min(1),
  capabilities: capabilitiesSchema,
  effort: effortSchema.optional(),
  inputCostPerMTok: tokenCostSchema,
  outputCostPerMTok: tokenCostSchema,
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  inputTokenSoftLimit: z.number().int().positive().optional(),
};

const openAICompatibleAgentSchema = z.object({
  type: z.literal('openai-compatible'),
  baseUrl: z.string().min(1, 'baseUrl is required for openai-compatible agents'),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  hostedTools: openAICompatibleHostedToolsSchema.optional(),
  ...baseAgentFields,
});

const claudeAgentSchema = z.object({
  type: z.literal('claude'),
  hostedTools: hostedToolsSchema.optional(),
  ...baseAgentFields,
}).strict();

const codexAgentSchema = z.object({
  type: z.literal('codex'),
  hostedTools: hostedToolsSchema.optional(),
  ...baseAgentFields,
}).strict();

const agentConfigSchema = z.discriminatedUnion('type', [
  openAICompatibleAgentSchema,
  claudeAgentSchema,
  codexAgentSchema,
]);

// === MultiModelConfig schema ===

const defaultsSchema = z.object({
  maxTurns: z.number().int().positive().default(200),
  timeoutMs: z.number().int().positive().default(600_000),
  tools: z.enum(['none', 'readonly', 'full']).default('full'),
  largeResponseThresholdChars: z.number().int().positive().optional(),
}).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const }));

export const multiModelConfigSchema = z.object({
  agents: z.object({
    standard: agentConfigSchema,
    complex: agentConfigSchema,
  }),
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
