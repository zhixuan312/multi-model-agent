import fs from 'fs';
import path from 'path';
import os from 'os';
import { multiModelConfigSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

const TOKEN_REGEX = /^[A-Za-z0-9_\-+=/.]+$/;

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
      agent.type === 'openai-compatible' &&
      typeof (agent as { apiKey?: unknown }).apiKey === 'string'
    ) {
      offenders.push(name);
    }
  }
  return offenders;
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
