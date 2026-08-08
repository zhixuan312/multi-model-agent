import { z } from 'zod';
import { CLIENT_IDS } from '../clients/client-id.js';

// === Shared field schemas ===

const TrimmedNonEmpty = z.string().trim().min(1);

// === Research config schema ===

export const ResearchConfigSchema = z.object({
  brave: z.object({
    apiKeys: z.array(TrimmedNonEmpty)
              .max(32)
              .transform(arr => Array.from(new Set(arr)))
              .default([]),
    timeoutMs: z.number().int().positive().max(30_000).default(8000),
    maxResultsPerQuery: z.number().int().positive().max(20).default(20),
    perCallBackoffMs: z.number().int().min(0).max(2_000).default(250),
    // Minimum spacing between two requests on the SAME key. Brave's free tier
    // is 1 req/s/token; without this gate the orchestrator's concurrent fan-out
    // bursts multiple queries onto a round-robin key within milliseconds → 429.
    // 0 disables the gate. 1100ms keeps each key just under the 1 req/s ceiling.
    minPerKeyIntervalMs: z.number().int().min(0).max(10_000).default(1100),
  }).strict().default(() => ({ apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 })),
  builtinAdapters: z.object({
    arxiv: z.boolean().default(true),
    semanticScholar: z.boolean().default(true),
    semanticScholarApiKey: z.string().min(1).optional(),
    githubSearch: z.boolean().default(true),
    githubPat: z.string().min(1).optional(),
    openalex: z.boolean().default(true),
    crossref: z.boolean().default(true),
    pubmed: z.boolean().default(true),
    pubmedApiKey: z.string().min(1).optional(),
    contactEmail: z.string().email().optional(),
  }).strict().default(() => ({
    arxiv: true, semanticScholar: true, githubSearch: true,
    openalex: true, crossref: true, pubmed: true,
  })),
}).strict().default(() => ({
  brave: { apiKeys: [] as string[], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
  builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, openalex: true, crossref: true, pubmed: true },
}));

export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

// Reasoning effort per tier. Stays OPTIONAL on purpose: the default lives in
// providers/effort.ts (DEFAULT_EFFORT = 'high') rather than here, so a parsed
// config never materializes a level the user did not write — /configure-provider
// persists config.agents wholesale and would otherwise pin every tier to the
// default of the day. Omitted → 'high'. Runners drop it for models with no
// effort knob.
const effortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
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

// Named constants are the single source of truth for server defaults.
// Each .default(() => ({...})) references the same constant so changing a
// value here = one edit, not three. Zod 4 requires explicit defaults at each
// wrapper level when the parent field is omitted; `.default({})` alone does
// not cascade to fill in leaf defaults.

/** Raw (possibly compressed) request body cap — 256 KiB. */
export const COMPRESSED_BODY_LIMIT_BYTES = 256 * 1024;

const DEFAULT_SERVER_AUTH = {
  tokenFile: '~/.mma/auth-token',
};

const DEFAULT_SERVER_LIMITS = {
  maxBodyBytes: COMPRESSED_BODY_LIMIT_BYTES,
  batchTtlMs: 3_600_000,
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
  stateDir: '~/.mma/state',
};

const serverLimitsSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.maxBodyBytes),
  batchTtlMs: z.number().int().positive().default(DEFAULT_SERVER_LIMITS.batchTtlMs),
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
  /** Directory for the daemon's durable state (execution records SQLite).
   *  Terminal task results survive a restart here; previously-active tasks are
   *  reconciled to `interrupted` on boot. */
  stateDir: z.string().default(DEFAULT_SERVER.stateDir),
}).default(() => DEFAULT_SERVER);

export const serverConfigSchema = z.object({
  server: serverBlockSchema,
}).strict();

export const multiModelConfigSchema = z.object({
  /**
   * Optional at the SCHEMA level, required to actually run a daemon.
   *
   * The two are different questions. `mma serve` cannot do anything without
   * tiers, and refuses to start without them — but provisioning a client does
   * not involve a model at all, and on a fresh machine `mma sync` needs to
   * record `clients.<id>: "on"` somewhere durable before any tier has been
   * chosen. Requiring `agents` here made that impossible: the only file the
   * roster may live in was a file that could not yet be written.
   *
   * So the check moved to where the requirement actually is. `assertRunnable`
   * below is what the daemon calls, and it reports the missing tiers by name
   * instead of a Zod path.
   */
  /* Each tier is optional HERE and required by `assertRunnable`, for the same
   * reason the whole block is optional: a partially-filled `agents` block is a
   * real state on the way to a complete one (`mma configure-provider` writes one
   * tier at a time), and the daemon is the thing that needs all three. Requiring
   * a tier in this schema would reject that file with a raw Zod `invalid_type`
   * at path `["agents","main"]` — precisely the message the comment above says
   * to avoid, and the message EVERY config written before 6.6.0 would get. */
  agents: z.object({
    standard: agentConfigSchema.optional(),
    complex: agentConfigSchema.optional(),
    /* `main` is the model driving mma. It resolves an `agentTier: 'main'`
     * dispatch and prices every run's main-model-equivalent cost. Optional in
     * this schema, required to serve: `assertRunnable` refuses a config without
     * it, and the runtime then prices every run against `agents.main.model`
     * with no fallback to another tier. Before 6.6.0 an absent `main` left the
     * baseline to a guess, which resolved to a worker tier's own model. */
    main: agentConfigSchema.optional(),
  }).optional(),
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
  // Optional strict declaration of which canonical clients are provisioned.
  // partialRecord (not record): a record with an enum key requires EVERY
  // key present, so a config declaring only `{ cursor: 'off' }` would be
  // rejected outright. Unknown keys and states are rejected either way.
  clients: z.partialRecord(z.enum(CLIENT_IDS), z.enum(['on', 'off'])).optional(),
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

/**
 * A config that can actually run a daemon: every required tier is present.
 *
 * `MultiModelConfig` describes what may legally sit in the file; this describes
 * what `mma serve` needs. Separating them is what lets `mma sync` write a roster
 * to a machine that has not chosen its models yet.
 */
export type RunnableConfig = MultiModelConfig & {
  agents: Required<NonNullable<MultiModelConfig['agents']>>;
};

/**
 * Narrow a loaded config to one the daemon can serve, or throw naming what is
 * missing.
 *
 * Deliberately a thrown error rather than a Zod refinement: by the time this
 * runs the user has a real file on disk, and "agents.standard is not
 * configured — run `mma configure-provider` or add it to <path>" is a better
 * thing to read than an `invalid_type` at path `["agents"]`.
 */
export function assertRunnable(config: MultiModelConfig, configPath?: string): asserts config is RunnableConfig {
  const missing: string[] = [];
  if (!config.agents) missing.push('agents.standard', 'agents.complex', 'agents.main');
  else {
    if (!config.agents.standard) missing.push('agents.standard');
    if (!config.agents.complex) missing.push('agents.complex');
    if (!config.agents.main) missing.push('agents.main');
  }
  if (missing.length === 0) return;
  const where = configPath ? ` in ${configPath}` : '';
  throw new Error(
    `multi-model-agent cannot start: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not configured${where}. `
    + 'Add the tier(s) to your config, or configure a provider from a running daemon. '
    + 'Provisioning commands (`mma sync`, `mma clients`) do not need tiers and work without them.',
  );
}
