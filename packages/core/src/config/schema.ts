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

// `claude-compatible` targets an Anthropic-format endpoint hosted by another
// vendor (e.g. DeepSeek's https://api.deepseek.com/anthropic). It mirrors
// `openai-compatible`: required baseUrl + apiKey/apiKeyEnv, talks the same
// wire format as the canonical provider.
const claudeCompatibleAgentSchema = z.object({
  type: z.literal('claude-compatible'),
  baseUrl: z.string().min(1, 'baseUrl is required for claude-compatible agents'),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
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
  claudeCompatibleAgentSchema,
  codexAgentSchema,
]);

// === MultiModelConfig schema ===

const defaultsSchema = z.object({
  timeoutMs: z.number().int().positive().default(1_800_000),
  // Stall watchdog: abort the in-flight runner when no LLM/tool/text event
  // has fired for this many ms. Independent of timeoutMs (which is total
  // task wall-clock). Default 10 minutes — long enough for the longest
  // single tool calls (large diffs, slow shell), short enough that a
  // model that vanishes into a thinking-loop is killed promptly.
  stallTimeoutMs: z.number().int().positive().default(600_000),
  maxCostUSD: z.number().nonnegative().default(10),
  tools: z.enum(['none', 'readonly', 'no-shell', 'full']).default('full'),
  sandboxPolicy: z.enum(['none', 'cwd-only']).default('cwd-only'),
  largeResponseThresholdChars: z.number().int().positive().optional(),
  parentModel: z.string().min(1).optional(),
}).default(() => ({
  timeoutMs: 1_800_000,
  stallTimeoutMs: 600_000,
  maxCostUSD: 10,
  tools: 'full' as const,
  sandboxPolicy: 'cwd-only' as const,
}));

// Named constants are the single source of truth for server defaults.
// Each .default(() => ({...})) references the same constant so changing a
// value here = one edit, not three. Zod 4 requires explicit defaults at each
// wrapper level when the parent field is omitted; `.default({})` alone does
// not cascade to fill in leaf defaults.

/** Raw (possibly compressed) request body cap — 256 KiB. */
export const COMPRESSED_BODY_LIMIT_BYTES = 256 * 1024;

const DEFAULT_SERVER_AUTH = {
  tokenFile: '~/.multi-model/auth-token',
};

const DEFAULT_SERVER_LIMITS = {
  maxBodyBytes: COMPRESSED_BODY_LIMIT_BYTES,
  batchTtlMs: 3_600_000,
  idleProjectTimeoutMs: 1_800_000,
  clarificationTimeoutMs: 86_400_000,
  projectCap: 200,
  maxBatchCacheSize: 500,
  maxContextBlockBytes: 524_288,
  maxContextBlocksPerProject: 32,
  shutdownDrainMs: 30_000,
};

const DEFAULT_SERVER = {
  bind: '127.0.0.1',
  port: 7337,
  auth: DEFAULT_SERVER_AUTH,
  limits: DEFAULT_SERVER_LIMITS,
  autoUpdateSkills: true,
};

const serverLimitsSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxBodyBytes),
  batchTtlMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.batchTtlMs),
  idleProjectTimeoutMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.idleProjectTimeoutMs),
  clarificationTimeoutMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.clarificationTimeoutMs),
  projectCap: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.projectCap),
  maxBatchCacheSize: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxBatchCacheSize),
  maxContextBlockBytes: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlockBytes),
  maxContextBlocksPerProject: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlocksPerProject),
  shutdownDrainMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.shutdownDrainMs),
}).default(() => DEFAULT_SERVER_LIMITS);

export const serverConfigSchema = z.object({
  server: z.object({
    bind: z.string().default(DEFAULT_SERVER.bind),
    port: z.number().int().nonnegative().default(DEFAULT_SERVER.port),
    auth: z.object({
      tokenFile: z.string().default(DEFAULT_SERVER_AUTH.tokenFile),
    }).default(() => DEFAULT_SERVER_AUTH),
    limits: serverLimitsSchema,
    autoUpdateSkills: z.boolean().default(DEFAULT_SERVER.autoUpdateSkills),
  }).default(() => DEFAULT_SERVER),
}).strict();

export const multiModelConfigSchema = z.object({
  agents: z.object({
    standard: agentConfigSchema,
    complex: agentConfigSchema,
  }),
  defaults: defaultsSchema,
  diagnostics: z.object({
    log: z.boolean().default(false),
    logDir: z.string().min(1).optional(),
    verbose: z.boolean().default(false),
  }).optional(),
  server: z.object({
    bind: z.string().default(DEFAULT_SERVER.bind),
    port: z.number().int().nonnegative().default(DEFAULT_SERVER.port),
    auth: z.object({
      tokenFile: z.string().default(DEFAULT_SERVER_AUTH.tokenFile),
    }).default(() => DEFAULT_SERVER_AUTH),
    limits: serverLimitsSchema,
    autoUpdateSkills: z.boolean().default(DEFAULT_SERVER.autoUpdateSkills),
  }).default(() => DEFAULT_SERVER),
  // Per spec §7.1: opt-in telemetry. The recorder reads this independently;
  // we only need to allow the key here so the strict() validation doesn't
  // reject configs that have it.
  telemetry: z.object({
    enabled: z.boolean(),
  }).optional(),
}).strict();

/** Inferred type for the standalone server configuration block. */
export type ServerConfig = z.infer<typeof serverConfigSchema>;

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
