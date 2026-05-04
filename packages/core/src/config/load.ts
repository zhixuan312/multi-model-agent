import fs from 'fs';
import path from 'path';
import os from 'os';
import { multiModelConfigSchema, pricingSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

const TOKEN_REGEX = /^[A-Za-z0-9_\-+=/.]+$/;

export type Pricing = {
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
  cachedReadUSDPerMillion: number;
  cachedNonReadUSDPerMillion: number;
};

export type MainAgentModelResolution =
  | { kind: 'shipped'; model: string; pricing: Pricing }
  | { kind: 'shipped_overrides_user'; model: string; pricing: Pricing; warning: string }
  | { kind: 'user_for_unknown'; model: string; pricing: Pricing }
  | { kind: 'fail'; reason: string };

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

/**
 * Load the auth token for the HTTP server.
 *
 * Env var `MMAGENT_AUTH_TOKEN` wins over any file (and bypasses file validation).
 * File contents must be exactly `<token>\n` — no CRLF, no extra whitespace, and
 * the token body must match `[A-Za-z0-9_\-+=/.]+`. Strict validation up front
 * prevents hard-to-diagnose bearer-token mismatches later.
 *
 * A leading `~/` in `tokenFile` is expanded to `os.homedir()` so configs using
 * the common `~/.multi-model/auth-token` pattern work without the caller
 * having to resolve it first.
 */
export function loadAuthToken(opts: { tokenFile: string }): string {
  const envToken = process.env['MMAGENT_AUTH_TOKEN'];
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  const resolvedPath = expandTilde(opts.tokenFile);
  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  if (raw.includes('\r\n')) {
    throw new Error(`config error: auth token file has CRLF line ending; use LF only (${resolvedPath})`);
  }
  if (!raw.endsWith('\n')) {
    throw new Error(`config error: auth token file must end with exactly one LF (${resolvedPath})`);
  }
  const token = raw.slice(0, -1);
  if (!TOKEN_REGEX.test(token)) {
    throw new Error(`config error: auth token file has non-canonical bytes (must match [A-Za-z0-9_\\-+=/.]) (${resolvedPath})`);
  }
  return token;
}

/**
 * Return the names of openai-compatible agents carrying an inline `apiKey`
 * instead of using `apiKeyEnv`. The schema permits both, but plaintext API
 * keys in a config file are a backup/dotfile/git footgun — serve surfaces
 * this once at startup so the operator can react.
 */
export function collectInlineApiKeyOffenders(config: MultiModelConfig): string[] {
  const offenders: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (
      (agent.type === 'openai-compatible' || agent.type === 'claude-compatible') &&
      typeof (agent as { apiKey?: unknown }).apiKey === 'string'
    ) {
      offenders.push(name);
    }
  }
  return offenders;
}

/**
 * Resolve pricing for the main agent model.
 *
 * Four cases per spec contract:
 * 1. Known model + no user pricing → shipped pricing.
 * 2. Known model + user pricing → shipped pricing WINS; caller should emit a one-time boot warning.
 * 3. Unknown model + user pricing → user pricing as the delta-calculation baseline.
 * 4. Unknown model + no user pricing → fail-loud at boot.
 */
export function resolveMainAgentModel(
  modelId: string,
  userPricing: Pricing | undefined,
  shippedPricing: Map<string, Pricing>,
): MainAgentModelResolution {
  const known = shippedPricing.get(modelId);
  if (known && !userPricing) return { kind: 'shipped', model: modelId, pricing: known };
  if (known && userPricing) {
    return {
      kind: 'shipped_overrides_user',
      model: modelId,
      pricing: known,
      warning: `user supplied pricing for known model '${modelId}'; ignoring user value in favor of shipped pricing`,
    };
  }
  if (!known && userPricing) return { kind: 'user_for_unknown', model: modelId, pricing: userPricing };
  return {
    kind: 'fail',
    reason: `mainAgentModel '${modelId}' is unknown to shipped pricing; supply 'mainAgentPricing' in config or use a shipped model id.`,
  };
}

/**
 * Parse a user-supplied pricing object through the pricing schema.
 * Returns the validated Pricing or a ZodError.
 */
export function validateUserPricing(raw: unknown): Pricing {
  return pricingSchema.parse(raw) as Pricing;
}

/**
 * Load and parse a config file by path.
 * No auto-lookup — callers must provide the path.
 * Core has no knowledge of MULTI_MODEL_CONFIG env var or home-directory discovery.
 */
export async function loadConfigFromFile(path: string): Promise<MultiModelConfig> {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(new Error(`Config file not found: ${path}`));
        return;
      }
      try {
        const raw = JSON.parse(data);
        const parsed = multiModelConfigSchema.parse(raw);
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}
