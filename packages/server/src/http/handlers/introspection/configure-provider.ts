import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { findModelProfile, getClaudeOAuth } from '@zhixuan92/multi-model-agent-core';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { sendJson, sendError } from '../../errors.js';
import type { RawHandler, RequestContext } from '../../types.js';

const PROBE_TIMEOUT_MS = 5_000;

const oauthAuthSchema = z.object({ mode: z.literal('oauth') });
const apiKeyAuthSchema = z.object({
  mode: z.literal('api-key'),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.apiKey && !value.apiKeyEnv) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'api-key auth requires either apiKey or apiKeyEnv',
    });
  }
});

export const configureProviderSchema = z.object({
  tier: z.enum(['standard', 'complex', 'main']),
  provider: z.enum(['claude', 'codex']),
  model: z.string().min(1),
  auth: z.discriminatedUnion('mode', [oauthAuthSchema, apiKeyAuthSchema]),
  dryRun: z.boolean().default(true),
});

export type ConfigureProviderRequest = z.infer<typeof configureProviderSchema>;

export interface ProbeResult {
  reachable: boolean;
  modelListed: boolean | null;
  detail: string;
}

interface ConfigureProviderResponse {
  verified: boolean;
  reason: string;
  applied: boolean;
  tier: string;
  provider: string;
  model: {
    id: string;
    family: string;
    tier: string;
    recognized: boolean;
  };
  probe?: ProbeResult;
}

const CLAUDE_NATIVE_FAMILIES = new Set(['claude']);

const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CODEX_BASE_URL = 'https://api.openai.com';

/**
 * True if the codex CLI the runner will spawn (`MMA_CODEX_BIN ?? 'codex'` — the exact resolution in
 * codex-cli-launch.ts) is resolvable on this host. Only a spawn ENOENT counts as absent; a present
 * binary that errors on `--version` is still installed. Claude needs no binary (it uses the Agent SDK).
 */
function codexBinaryAvailable(): boolean {
  const bin = process.env.MMA_CODEX_BIN ?? 'codex';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ENOENT';
  }
}

function validate(input: ConfigureProviderRequest): { verified: boolean; reason: string } {
  const profile = findModelProfile(input.model);
  const family = profile.family;
  const recognized = family !== 'other';
  const hasBaseUrl = input.auth.mode === 'api-key' && !!input.auth.baseUrl;

  if (!recognized && !hasBaseUrl) {
    return { verified: false, reason: `Unrecognized model "${input.model}"; provide a baseUrl for custom models` };
  }

  if (!hasBaseUrl) {
    if (input.provider === 'claude' && !CLAUDE_NATIVE_FAMILIES.has(family)) {
      return { verified: false, reason: `${family} model requires codex provider, not claude` };
    }
    if (input.provider === 'codex' && CLAUDE_NATIVE_FAMILIES.has(family)) {
      return { verified: false, reason: `claude model requires claude provider, not codex` };
    }
  }

  // A codex tier runs via the `codex` CLI subprocess; if the binary is absent (e.g. not bundled in a
  // container image), the tier verifies green then dies on the FIRST real task with `codex_not_installed`
  // (ISSUE-11). Probe the runner here — for any codex tier, oauth or api-key — so verification reflects
  // can-actually-run, not just creds-present. (Claude uses the Agent SDK, so no binary check.)
  if (input.provider === 'codex' && !codexBinaryAvailable()) {
    const bin = process.env.MMA_CODEX_BIN ?? 'codex';
    return {
      verified: false,
      reason: `codex CLI not found (tried "${bin}"). A codex tier runs via the codex CLI — install @openai/codex or set MMA_CODEX_BIN; the tier cannot run without it.`,
    };
  }

  if (input.auth.mode === 'oauth') {
    const oauthResult = checkOAuth(input.provider);
    if (!oauthResult.available) {
      return { verified: false, reason: oauthResult.reason };
    }
    return { verified: true, reason: `${input.model} is available on ${input.provider} provider via OAuth` };
  }

  return { verified: true, reason: `${input.model} is available on ${input.provider} provider via API key` };
}

export async function probeApi(input: ConfigureProviderRequest): Promise<ProbeResult> {
  const baseUrl = input.auth.mode === 'api-key' && input.auth.baseUrl
    ? input.auth.baseUrl
    : input.provider === 'claude'
      ? DEFAULT_CLAUDE_BASE_URL
      : DEFAULT_CODEX_BASE_URL;

  const normalized = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const modelsUrl = `${normalized}/v1/models`;
  const headers: Record<string, string> = {};

  if (input.auth.mode === 'api-key') {
    const resolvedApiKey = resolveSubmittedApiKey(input);
    if (!resolvedApiKey) {
      return {
        reachable: false,
        modelListed: null,
        detail: `Environment variable "${input.auth.apiKeyEnv}" is not set`,
      };
    }
    if (input.provider === 'claude') {
      headers['x-api-key'] = resolvedApiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['authorization'] = `Bearer ${resolvedApiKey}`;
    }
  } else if (input.auth.mode === 'oauth') {
    if (input.provider === 'claude') {
      const creds = getClaudeOAuth();
      if (!creds) {
        return { reachable: false, modelListed: null, detail: 'OAuth token not available for probe' };
      }
      headers['authorization'] = `Bearer ${creds.accessToken}`;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      const token = readCodexOAuthToken();
      if (!token) {
        return { reachable: false, modelListed: null, detail: 'Codex OAuth token not found at ~/.codex/auth.json' };
      }
      return { reachable: true, modelListed: null, detail: 'Codex subscription auth present; model listing not available via session token' };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { reachable: false, modelListed: null, detail: `${res.status} ${res.statusText} from ${modelsUrl}` };
    }

    const body = await res.json() as { data?: Array<{ id: string }> };
    if (!body.data || !Array.isArray(body.data)) {
      return { reachable: true, modelListed: null, detail: 'Endpoint reachable but response has no model list' };
    }

    const found = body.data.some((m) => m.id === input.model);
    return {
      reachable: true,
      modelListed: found,
      detail: found
        ? `Model "${input.model}" found in ${body.data.length} available models`
        : `Model "${input.model}" not found in ${body.data.length} available models`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { reachable: false, modelListed: null, detail: `Probe timed out after ${PROBE_TIMEOUT_MS}ms` };
    }
    return { reachable: false, modelListed: null, detail: `Connection failed: ${msg}` };
  }
}

/**
 * Resolve the credential the probe should verify.
 *
 * Precedence MUST match `applyToConfig()` below, which persists `apiKeyEnv` in
 * preference to an inline `apiKey`. If the two disagreed, a request carrying both
 * could verify against the inline key and then persist an env reference that is
 * unset or holds a different value — reporting `verified: true` for a config that
 * fails on the very next request. Verify exactly what gets saved.
 */
function resolveSubmittedApiKey(input: ConfigureProviderRequest): string | undefined {
  if (input.auth.mode !== 'api-key') return undefined;
  // When apiKeyEnv is supplied it is the ONLY source considered — no fallback to an
  // inline apiKey. An unset env var must fail the probe rather than silently verify
  // against a value that will not be persisted.
  if (input.auth.apiKeyEnv) return process.env[input.auth.apiKeyEnv];
  return input.auth.apiKey;
}

/**
 * The only part of a config `applyToConfig` and `persistConfig` read or write.
 *
 * Declaring `MultiModelConfig` here was over-wide in both directions. Neither function touches
 * anything but `agents`, and `MultiModelConfig.agents` is a CLOSED `{standard?, complex?, main?}`
 * shape while both write by dynamic tier key — so the signature demanded more than the functions
 * need AND described the wrong thing about the one field they use. Four casts existed only to
 * bridge that gap: two `as never` at the `mma setup` call sites, which erased the argument type
 * entirely, and two inside `applyToConfig`. Naming the real requirement removes all four.
 */
/**
 * One tier entry as these functions treat it: an open record that MAY carry `effort`. Open because
 * a tier written by an older release can hold keys this code does not know, and rewriting a tier
 * must not silently drop them.
 */
export type AgentTierEntry = Record<string, unknown> & { effort?: string };

export interface AgentsCarrier {
  agents?: Record<string, AgentTierEntry | undefined>;
}

export function applyToConfig(config: AgentsCarrier, input: ConfigureProviderRequest): void {
  // A config being written for the first time has no agents at all — `mma setup`
  // creates the block as it fills the first tier.
  if (!config.agents) config.agents = {};
  // The tier entry is replaced wholesale, so a per-tier reasoning level the
  // user set by hand has to be carried across — otherwise swapping a model
  // from the Models page silently resets that tier to DEFAULT_EFFORT.
  const previousEffort = config.agents[input.tier]?.effort;
  // Only a genuine override survives — an absent effort stays absent so the
  // written config keeps meaning "use the default".
  const agentConfig: Record<string, unknown> = {
    type: input.provider,
    model: input.model,
    ...(previousEffort && { effort: previousEffort }),
  };

  if (input.auth.mode === 'api-key') {
    if (input.auth.apiKeyEnv) {
      agentConfig.apiKeyEnv = input.auth.apiKeyEnv;
    } else if (input.auth.apiKey) {
      agentConfig.apiKey = input.auth.apiKey;
    }
    if (input.auth.baseUrl) agentConfig.baseUrl = input.auth.baseUrl;
  }

  config.agents[input.tier] = agentConfig;
}

export function persistConfig(configPath: string, config: AgentsCarrier): { ok: boolean; error?: string } {
  try {
    // The directory may not exist yet: `mma setup` on a fresh machine writes the
    // very first ~/.mma/config.json. Every prior caller reached here with a
    // config already on disk, so this was never exercised.
    mkdirSync(dirname(configPath), { recursive: true });
    const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    const merged = { ...existing, agents: config.agents };
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readCodexOAuthToken(): string | null {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) return null;
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    return data.OPENAI_API_KEY || data.tokens?.access_token || null;
  } catch {
    return null;
  }
}

function checkOAuth(provider: 'claude' | 'codex'): { available: boolean; reason: string } {
  if (provider === 'claude') {
    try {
      const creds = getClaudeOAuth();
      if (!creds) {
        return { available: false, reason: 'Claude OAuth token not found or expired; log in to Claude Code first' };
      }
      return { available: true, reason: 'OAuth token found' };
    } catch {
      return { available: false, reason: 'Claude OAuth not available on this platform' };
    }
  }
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) {
      return { available: false, reason: 'Codex auth not found at ~/.codex/auth.json; log in via codex CLI first' };
    }
    return { available: true, reason: 'Codex auth found' };
  } catch {
    return { available: false, reason: 'Codex auth check failed' };
  }
}

export function buildConfigureProviderHandler(config: MultiModelConfig | undefined, configPath?: string): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, ctx: RequestContext) => {
    const parsed = configureProviderSchema.safeParse(ctx.body);
    if (!parsed.success) {
      // Structured field-level errors, consistent with the unified-task and
      // context-blocks handlers — callers get { fieldErrors: { <field>: [msgs] } }
      // so they know WHICH field is invalid, not just a flat joined message.
      sendError(res, 400, 'invalid_request', 'Request body validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const profile = findModelProfile(input.model);
    const modelInfo = {
      id: input.model,
      family: profile.family,
      tier: profile.tier,
      recognized: profile.family !== 'other',
    };

    let { verified, reason } = validate(input);

    let probeResult: ProbeResult | undefined;
    if (verified) {
      probeResult = await probeApi(input);
      if (!probeResult.reachable) {
        verified = false;
        reason = probeResult.detail;
      } else if (probeResult.modelListed === false) {
        verified = false;
        reason = `Model "${input.model}" not listed at endpoint; ${probeResult.detail}`;
      }
    }

    let applied = false;
    if (verified && !input.dryRun) {
      if (!config) {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration');
        return;
      }
      applyToConfig(config, input);
      applied = true;

      if (configPath) {
        const persist = persistConfig(configPath, config);
        if (!persist.ok) {
          reason = `${reason}; applied to ${input.tier} tier but failed to persist: ${persist.error}`;
        }
      }
    }

    const response: ConfigureProviderResponse = {
      verified,
      reason: applied ? `${reason}; applied to ${input.tier} tier` : reason,
      applied,
      tier: input.tier,
      provider: input.provider,
      model: modelInfo,
      ...(probeResult && { probe: probeResult }),
    };

    sendJson(res, 200, response);
  };
}
