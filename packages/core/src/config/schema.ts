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
  timeoutMs: z.number().int().positive().default(1_800_000),
  maxCostUSD: z.number().nonnegative().default(10),
  tools: z.enum(['none', 'readonly', 'no-shell', 'full']).default('full'),
  sandboxPolicy: z.enum(['none', 'cwd-only']).default('cwd-only'),
  largeResponseThresholdChars: z.number().int().positive().optional(),
  parentModel: z.string().min(1).optional(),
}).default(() => ({
  timeoutMs: 1_800_000,
  maxCostUSD: 10,
  tools: 'full' as const,
  sandboxPolicy: 'cwd-only' as const,
}));

// Named constants are the single source of truth for transport defaults.
// Each .default(() => ({...})) references the same constant so changing a
// value here = one edit, not three. Zod 4 requires explicit defaults at each
// wrapper level when the parent field is omitted; `.default({})` alone does
// not cascade to fill in leaf defaults.
const DEFAULT_TRANSPORT_AUTH = {
  enabled: false,
  tokenPath: '~/.multi-model/runtime/token',
};

const DEFAULT_TRANSPORT_HTTP = {
  bind: '127.0.0.1',
  port: 7312,
  auth: DEFAULT_TRANSPORT_AUTH,
  projectIdleEvictionMs: 60 * 60 * 1000,
  projectCap: 50,
  shutdownDrainMs: 30_000,
  sessionIdleTimeoutMs: 30 * 60 * 1000,
};

const httpTransportSchema = z.object({
  bind: z.string().default(DEFAULT_TRANSPORT_HTTP.bind),
  port: z.number().int().positive().default(DEFAULT_TRANSPORT_HTTP.port),
  auth: z.object({
    enabled: z.boolean().default(DEFAULT_TRANSPORT_AUTH.enabled),
    tokenPath: z.string().default(DEFAULT_TRANSPORT_AUTH.tokenPath),
  }).default(() => DEFAULT_TRANSPORT_AUTH),
  projectIdleEvictionMs: z.number().int().positive().default(DEFAULT_TRANSPORT_HTTP.projectIdleEvictionMs),
  projectCap: z.number().int().positive().default(DEFAULT_TRANSPORT_HTTP.projectCap),
  shutdownDrainMs: z.number().int().positive().default(DEFAULT_TRANSPORT_HTTP.shutdownDrainMs),
  sessionIdleTimeoutMs: z.number().int().positive().default(DEFAULT_TRANSPORT_HTTP.sessionIdleTimeoutMs),
}).default(() => DEFAULT_TRANSPORT_HTTP);

const transportSchema = z.object({
  mode: z.enum(['stdio', 'http']).default('stdio'),
  http: httpTransportSchema,
}).default(() => ({ mode: 'stdio' as const, http: DEFAULT_TRANSPORT_HTTP }));

export const multiModelConfigSchema = z.object({
  agents: z.object({
    standard: agentConfigSchema,
    complex: agentConfigSchema,
  }),
  defaults: defaultsSchema,
  diagnostics: z.object({
    log: z.boolean().default(false),
    logDir: z.string().min(1).optional(),
  }).optional(),
  transport: transportSchema,
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
