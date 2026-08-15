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
 * Env var `MMA_AUTH_TOKEN` wins over any file (and bypasses file validation).
 * File contents must be exactly `<token>\n` — no CRLF, no extra whitespace, and
 * the token body must match `[A-Za-z0-9_\-+=/.]+`. Strict validation up front
 * prevents hard-to-diagnose bearer-token mismatches later.
 *
 * A leading `~/` in `tokenFile` is expanded to `os.homedir()` so configs using
 * the common `~/.mma/auth-token` pattern work without the caller
 * having to resolve it first.
 */
export function loadAuthToken(opts: { tokenFile: string }): string {
  // `envToken &&` already excludes the empty string; the `.length > 0` that used to follow it
  // could not change the outcome for any value.
  const envToken = process.env['MMA_AUTH_TOKEN'];
  if (envToken) return envToken;
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
 * Load and parse a config file by path.
 * No auto-lookup — callers must provide the path.
 * Core has no knowledge of MULTI_MODEL_CONFIG env var or home-directory discovery.
 */
export async function loadConfigFromFile(path: string): Promise<MultiModelConfig> {
  let data: string;
  try {
    data = await fs.promises.readFile(path, 'utf-8');
  } catch (err) {
    // Every read failure used to report `Config file not found`. A file that exists but cannot be
    // read — wrong owner after a sudo install, a directory where a file was expected, too many
    // open files — sent the operator looking for a missing file that was sitting right there.
    // ENOENT keeps the original wording because that IS the common case and it reads well; every
    // other errno says what actually happened and keeps the cause for a stack trace.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Config file not found: ${path}`, { cause: err });
    throw new Error(
      `Config file at ${path} could not be read (${code ?? 'unknown error'}): ` +
      `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    return multiModelConfigSchema.parse(JSON.parse(data));
  } catch (e) {
    throw new Error(`Invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
