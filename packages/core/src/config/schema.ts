import { z } from 'zod';
import type {
  MultiModelConfig,
} from '../types.js';

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
const FORBIDDEN_HOST_CHARS = /[\/:@?#]|:\/\//;
const IPV4_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_LITERAL = /^\[?[0-9a-fA-F:]+\]?$/;

const HostString = z.string().trim().min(1).max(253).transform((raw, ctx) => {
  if (FORBIDDEN_HOST_CHARS.test(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'must be a bare hostname — no scheme, path, port, credentials, query, or fragment' });
    return z.NEVER;
  }
  if (IPV4_LITERAL.test(raw) || IPV6_LITERAL.test(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'IP literals are not allowed in fetchAllowlistExtra (use a DNS hostname)' });
    return z.NEVER;
  }
  const isAscii = /^[\x00-\x7f]+$/.test(raw);
  let canonical: string;
  if (isAscii) {
    try {
      canonical = new URL(`https://${raw}`).hostname;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid hostname' });
      return z.NEVER;
    }
  } else {
    try {
      canonical = new URL(`https://${raw}`).hostname;
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg.includes('ICU') || /full-icu|small-icu/i.test(msg)
          ? 'invalid_hostname_idna_unavailable: this Node build was compiled without full ICU; cannot IDNA-normalize non-ASCII hostnames'
          : 'invalid hostname',
      });
      return z.NEVER;
    }
  }
  const labels = canonical.split('.');
  if (labels.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'must be a fully-qualified domain name with at least one dot' });
    return z.NEVER;
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: `DNS label "${label}" must be 1-63 characters` });
      return z.NEVER;
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom,
        message: `DNS label "${label}" must not start or end with a hyphen` });
      return z.NEVER;
    }
  }
  return canonical;
});

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
  }).strict().default(() => ({ apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 10, perCallBackoffMs: 250 })),
  fetch: z.object({
    maxRedirects: z.number().int().min(0).max(5).default(3),
    connectTimeoutMs: z.number().int().positive().max(10_000).default(5_000),
    totalDeadlineMs: z.number().int().positive().max(30_000).default(12_000),
    maxBodyBytes: z.number().int().positive().max(4 * 1024 * 1024).default(1024 * 1024),
    allowPrivateNetwork: z.boolean().default(false),
  }).strict().refine(
    v => v.totalDeadlineMs >= v.connectTimeoutMs,
    { message: 'fetch_invalid_deadlines: totalDeadlineMs must be >= connectTimeoutMs' },
  ).default(() => ({ maxRedirects: 3, connectTimeoutMs: 5_000, totalDeadlineMs: 12_000, maxBodyBytes: 1024 * 1024, allowPrivateNetwork: false })),
  builtinAdapters: z.object({
    arxiv: z.boolean().default(true),
    semanticScholar: z.boolean().default(true),
    githubSearch: z.boolean().default(true),
    genericRss: z.boolean().default(true),
  }).strict().default(() => ({ arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true })),
  userSources: z.array(TrimmedNonEmpty.max(2000)).max(50).default([]),
  fetchAllowlistExtra: z.array(HostString)
                        .max(64)
                        .transform(arr => Array.from(new Set(arr)))
                        .default([]),
}).strict().default(() => ({
  brave: { apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 10, perCallBackoffMs: 250 },
  fetch: { maxRedirects: 3, connectTimeoutMs: 5_000, totalDeadlineMs: 12_000, maxBodyBytes: 1024 * 1024, allowPrivateNetwork: false },
  builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true },
  userSources: [] as string[],
  fetchAllowlistExtra: [] as string[],
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
  maxBatchCacheSize: 500,
  maxContextBlockBytes: 524_288,
  maxContextBlocksPerProject: 500,
  maxProjects: 500,
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
  maxBatchCacheSize: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxBatchCacheSize),
  maxContextBlockBytes: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlockBytes),
  maxContextBlocksPerProject: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxContextBlocksPerProject),
  maxProjects: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxProjects),
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
  }),
  defaults: defaultsSchema,
  diagnostics: z.object({
    log: z.boolean().default(false),
    logDir: z.string().min(1).optional(),
    verbose: z.boolean().default(false),
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
