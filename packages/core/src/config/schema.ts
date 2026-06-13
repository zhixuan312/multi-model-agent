import { z } from 'zod';

/** Total wall-clock cap per task — 60 min. Bumped from 30 min in v3.9.0
 * after the 32-min hang on batch 1574b3a2 showed reviewers had no cap
 * at all. The right number is "long enough that legitimate slow tasks
 * don't false-trigger; short enough that a hung reviewer doesn't camp
 * forever." Tune via per-stage telemetry once we have a few hundred runs
 * with the new fields. */
export const DEFAULT_TASK_TIMEOUT_MS = 3_600_000;

/** Idle-gap watchdog — 20 min. No `turn_start | text_emission | tool_call
 * | turn_complete` event for this long → force-abort the in-flight call.
 * Bumped from 10 min in v3.9.0 — the prior value occasionally fired on
 * legitimately slow reviewers (deepseek-v4-pro, large diffs). */
export const DEFAULT_STALL_TIMEOUT_MS = 1_200_000;

/** Wall-clock pre-stop ratio — the runtime warns at
 * DEFAULT_TASK_TIMEOUT_MS × this ratio (48 min), with a worst-case
 * total of DEFAULT_TASK_TIMEOUT_MS / MAX_TIME_PRESTOP_RATIO (1.25 h). */
export const MAX_TIME_PRESTOP_RATIO = 0.80;

// === Shared field schemas ===

const TrimmedNonEmpty = z.string().trim().min(1);

// `://` is already covered by the character class (the `:` and `/` matches),
// kept here only as a defensive belt-and-braces against future class edits
// that might accidentally drop one of those characters. If you simplify the
// class, drop the alternation too. Both branches reject the same inputs today.
// === Research config schema ===

export const ResearchConfigSchema = z.object({
  brave: z.object({
    apiKeys: z.array(TrimmedNonEmpty)
              .max(32)
              .transform(arr => Array.from(new Set(arr)))
              .default([]),
    timeoutMs: z.number().int().positive().max(30_000).default(8000),
    maxResultsPerQuery: z.number().int().positive().max(20).default(10),
    perCallBackoffMs: z.number().int().min(0).max(2_000).default(250),
    // Minimum spacing between two requests on the SAME key. Brave's free tier
    // is 1 req/s/token; without this gate the orchestrator's concurrent fan-out
    // bursts multiple queries onto a round-robin key within milliseconds → 429.
    // 0 disables the gate. 1100ms keeps each key just under the 1 req/s ceiling.
    minPerKeyIntervalMs: z.number().int().min(0).max(10_000).default(1100),
  }).strict().default(() => ({ apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 10, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 })),
  builtinAdapters: z.object({
    arxiv: z.boolean().default(true),
    semanticScholar: z.boolean().default(true),
    semanticScholarApiKey: z.string().min(1).optional(),
    githubSearch: z.boolean().default(true),
    githubPat: z.string().min(1).optional(),
  }).strict().default(() => ({
    arxiv: true, semanticScholar: true, githubSearch: true,
  })),
}).strict().default(() => ({
  brave: { apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 10, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
  builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true },
}));

export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

const effortSchema = z.enum(['none', 'low', 'medium', 'high']);
const sandboxPolicySchema = z.enum(['none', 'cwd-only']).optional();
// Per-million-token pricing for cost computation. Must be non-negative; zero
// is allowed (free agents can set both rates to 0 to get a deterministic
// costUSD: 0 instead of null).
const tokenCostSchema = z.number().nonnegative().finite().optional();

const baseAgentFields = {
  model: z.string().min(1, "agents.<tier>.model must be a single non-empty string id; v4.0 enforces tier → single model 1:1 invariant"),
  effort: effortSchema.optional(),
  inputCostPerMTok: tokenCostSchema,
  outputCostPerMTok: tokenCostSchema,
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  inputTokenSoftLimit: z.number().int().positive().optional(),
};

// v4.4: two provider types only. `claude` covers Anthropic API + any
// Anthropic-compatible proxy (set baseUrl). `codex` covers ChatGPT
// subscription + OpenAI API + any OpenAI-compatible endpoint (Groq,
// DeepSeek, OpenRouter, Together, LM Studio, Ollama — set baseUrl +
// apiKeyEnv to enable). The compatibility variants from earlier
// releases have been removed — collapse all of them onto `claude` or
// `codex` with the appropriate `baseUrl` set.
const claudeAgentSchema = z.object({
  type: z.literal('claude'),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  ...baseAgentFields,
}).strict();

const codexAgentSchema = z.object({
  type: z.literal('codex'),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  ...baseAgentFields,
}).strict();

const agentConfigSchema = z.discriminatedUnion('type', [
  claudeAgentSchema,
  codexAgentSchema,
]);

// === MultiModelConfig schema ===

const defaultsSchema = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_TASK_TIMEOUT_MS),
  stallTimeoutMs: z.number().int().positive().default(DEFAULT_STALL_TIMEOUT_MS),
  tools: z.enum(['none', 'readonly', 'no-shell', 'full']).default('full'),
  sandboxPolicy: z.enum(['none', 'cwd-only']).default('cwd-only'),
  largeResponseThresholdChars: z.number().int().positive().optional(),
  // A6.x (4.3.0+): mainModel re-introduced as the lowest-priority fallback
  // in the resolver chain. Headers + per-client auto-detection take
  // precedence; this is the explicit operator override / last resort.
  mainModel: z.string().min(1).optional(),
  progressWatchdogEnabled: z.boolean().optional(),
  thrashTurns: z.number().int().positive().optional(),
  thrashWallClockMs: z.number().int().positive().optional(),
  thrashSoftTurns: z.number().int().positive().optional(),
}).default(() => ({
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
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
  projectCap: 200,
  maxContextBlockBytes: 524_288,
  maxContextBlocksPerProject: 500,
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
  projectCap: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.projectCap),
  maxContextBlockBytes: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlockBytes),
  maxContextBlocksPerProject: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlocksPerProject),
  shutdownDrainMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.shutdownDrainMs),
}).default(() => DEFAULT_SERVER_LIMITS);

const serverBlockSchema = z.object({
  bind: z.string().default(DEFAULT_SERVER.bind),
  port: z.number().int().nonnegative().default(DEFAULT_SERVER.port),
  auth: z.object({
    tokenFile: z.string().default(DEFAULT_SERVER_AUTH.tokenFile),
  }).default(() => DEFAULT_SERVER_AUTH),
  limits: serverLimitsSchema,
  autoUpdateSkills: z.boolean().default(DEFAULT_SERVER.autoUpdateSkills),
}).default(() => DEFAULT_SERVER);

export const serverConfigSchema = z.object({
  server: serverBlockSchema,
}).strict();

export const multiModelConfigSchema = z.object({
  agents: z.object({
    standard: agentConfigSchema,
    complex: agentConfigSchema,
    main: agentConfigSchema.optional(),
  }),
  defaults: defaultsSchema,
  diagnostics: z.object({
    log: z.boolean().default(false),
    logDir: z.string().min(1).optional(),
  }).optional(),
  server: serverBlockSchema,
  // Per spec §7.1: opt-in telemetry. The recorder reads this independently;
  // we only need to allow the key here so the strict() validation doesn't
  // reject configs that have it.
  telemetry: z.object({
    enabled: z.boolean(),
  }).optional(),
  research: ResearchConfigSchema,
}).strict();

/** Canonical config types — inferred from the Zod schemas above so the
 *  validated shape and the TypeScript type can never drift. Provider configs
 *  (ClaudeProviderConfig / CodexProviderConfig / ProviderConfig) have no Zod
 *  schema and remain hand-written in types/config.ts. */
export type MultiModelConfig = z.infer<typeof multiModelConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Inferred type for the standalone server configuration block. */
export type ServerConfig = z.infer<typeof serverConfigSchema>;

/**
 * Parse a raw config object — validates schema, no side effects.
 * Does NOT load from disk.
 */
export function parseConfig(raw: unknown): MultiModelConfig {
  return multiModelConfigSchema.parse(raw);
}
