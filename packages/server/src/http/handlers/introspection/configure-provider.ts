import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
});

const configureProviderSchema = z.object({
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

export interface ConfigureProviderResponse {
  usable: boolean;
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

function validate(input: ConfigureProviderRequest): { usable: boolean; reason: string } {
  const profile = findModelProfile(input.model);
  const family = profile.family;
  const recognized = family !== 'other';
  const hasBaseUrl = input.auth.mode === 'api-key' && !!input.auth.baseUrl;

  if (!recognized && !hasBaseUrl) {
    return { usable: false, reason: `Unrecognized model "${input.model}"; provide a baseUrl for custom models` };
  }

  if (!hasBaseUrl) {
    if (input.provider === 'claude' && !CLAUDE_NATIVE_FAMILIES.has(family)) {
      return { usable: false, reason: `${family} model requires codex provider, not claude` };
    }
    if (input.provider === 'codex' && CLAUDE_NATIVE_FAMILIES.has(family)) {
      return { usable: false, reason: `claude model requires claude provider, not codex` };
    }
  }

  if (input.auth.mode === 'oauth') {
    const oauthResult = checkOAuth(input.provider);
    if (!oauthResult.available) {
      return { usable: false, reason: oauthResult.reason };
    }
    return { usable: true, reason: `${input.model} is available on ${input.provider} provider via OAuth` };
  }

  return { usable: true, reason: `${input.model} is available on ${input.provider} provider via API key` };
}

async function probeApi(input: ConfigureProviderRequest): Promise<ProbeResult> {
  const baseUrl = input.auth.mode === 'api-key' && input.auth.baseUrl
    ? input.auth.baseUrl
    : input.provider === 'claude'
      ? DEFAULT_CLAUDE_BASE_URL
      : DEFAULT_CODEX_BASE_URL;

  const normalized = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const modelsUrl = `${normalized}/v1/models`;
  const headers: Record<string, string> = {};

  if (input.auth.mode === 'api-key') {
    if (input.provider === 'claude') {
      headers['x-api-key'] = input.auth.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['authorization'] = `Bearer ${input.auth.apiKey}`;
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
      return { reachable: false, modelListed: null, detail: 'Codex OAuth probe not supported; auth managed by codex CLI' };
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

function applyToConfig(config: MultiModelConfig, input: ConfigureProviderRequest): void {
  const agentConfig: Record<string, unknown> = {
    type: input.provider,
    model: input.model,
  };

  if (input.auth.mode === 'api-key') {
    agentConfig.apiKey = input.auth.apiKey;
    if (input.auth.baseUrl) agentConfig.baseUrl = input.auth.baseUrl;
  }

  (config.agents as Record<string, unknown>)[input.tier] = agentConfig;
}

function persistConfig(configPath: string, config: MultiModelConfig): { ok: boolean; error?: string } {
  try {
    const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    const merged = { ...existing, agents: config.agents };
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      sendError(res, 400, 'invalid_request', parsed.error.issues.map(i => i.message).join('; '));
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

    let { usable, reason } = validate(input);

    let probeResult: ProbeResult | undefined;
    if (usable) {
      probeResult = await probeApi(input);
      if (!probeResult.reachable) {
        usable = false;
        reason = probeResult.detail;
      } else if (probeResult.modelListed === false) {
        usable = false;
        reason = `Model "${input.model}" not listed at endpoint; ${probeResult.detail}`;
      }
    }

    let applied = false;
    if (usable && !input.dryRun) {
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
      usable,
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
