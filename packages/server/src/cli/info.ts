/**
 * info.ts — `mmagent info` subcommand.
 *
 * One-shot identity probe: emits CLI version, configured bind/port, token
 * fingerprint (sha256 first 8 hex chars), and — if the daemon is reachable —
 * daemon version/pid/startedAt/uptimeMs from GET /health. Designed to be
 * parseable with --json for scripts and human-readable without it.
 *
 * Usage:
 *   mmagent info [--config <path>] [--json]
 */
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { notApplicable, type NotApplicable } from '@zhixuan92/multi-model-agent-core';

export interface InfoDeps {
  /** CLI package version (read from the server package.json at startup). */
  cliVersion: string;
  /** Config bind address (e.g. '127.0.0.1'). */
  bind: string;
  /** Config port (e.g. 7337). */
  port: number;
  /** Token file path (already resolved from config, no tilde expansion yet). */
  tokenFile: string;
  /** Home dir for tilde expansion. Defaults to os.homedir(). */
  homeDir?: string;
  /** Emit machine-readable JSON instead of a human summary. */
  json?: boolean;
  /** stdout writer (for testing). */
  stdout?: (s: string) => boolean;
  /** stderr writer (for testing). */
  stderr?: (s: string) => boolean;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface InfoJson {
  cliVersion: string;
  daemonVersion: string | NotApplicable;
  bind: string;
  port: number;
  pid: number | NotApplicable;
  uptimeMs: number | NotApplicable;
  startedAt: number | NotApplicable;
  tokenFingerprint: string;
  running: boolean;
}

function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

function resolveHome(p: string, homeDir: string): string {
  return p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p;
}

export async function runInfo(deps: InfoDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const fetcher = deps.fetch ?? fetch;
  const homeDir = deps.homeDir ?? os.homedir();
  const json = deps.json ?? false;

  const resolvedTokenFile = resolveHome(deps.tokenFile, homeDir);
  let tokenFp: string;
  try {
    const token = readFileSync(resolvedTokenFile, 'utf-8').trim();
    if (token.length === 0) {
      stderr(`mmagent info: auth token file is empty: ${resolvedTokenFile}\n`);
      return 1;
    }
    tokenFp = fingerprint(token);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'ENOENT') {
      stderr(`mmagent info: auth token file not found: ${resolvedTokenFile}\n`);
    } else {
      stderr(`mmagent info: cannot read auth token file: ${msg}\n`);
    }
    return 1;
  }

  const host = (deps.bind === '0.0.0.0' || deps.bind === '::') ? '127.0.0.1' : deps.bind;
  const healthUrl = `http://${host}:${deps.port}/health`;

  let running = false;
  let health: Record<string, unknown> | null = null;
  try {
    const res = await fetcher(healthUrl, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      health = await res.json() as Record<string, unknown>;
      running = true;
    }
  } catch {
    // daemon not running — leave running=false
  }

  const fromHealth = (key: string, validate: (v: unknown) => boolean) => {
    if (!running) return notApplicable('daemon not running');
    const v = health?.[key];
    if (validate(v)) return v;
    return notApplicable('daemon version predates info fields');
  };

  const info: InfoJson = {
    cliVersion: deps.cliVersion,
    daemonVersion: fromHealth('version', (v): v is string => typeof v === 'string' && v.length > 0) as string | NotApplicable,
    bind: deps.bind,
    port: deps.port,
    pid: fromHealth('pid', (v): v is number => typeof v === 'number') as number | NotApplicable,
    uptimeMs: fromHealth('uptimeMs', (v): v is number => typeof v === 'number') as number | NotApplicable,
    startedAt: fromHealth('startedAt', (v): v is number => typeof v === 'number') as number | NotApplicable,
    tokenFingerprint: tokenFp,
    running,
  };

  if (json) {
    stdout(JSON.stringify(info, null, 2) + '\n');
    return 0;
  }

  const parts: string[] = [`mmagent cli=${info.cliVersion}`];
  if (typeof info.daemonVersion === 'string') parts.push(`daemon=${info.daemonVersion}`);
  parts.push(`bind=${info.bind}:${info.port}`);
  if (typeof info.pid === 'number') parts.push(`pid=${info.pid}`);
  if (typeof info.uptimeMs === 'number') parts.push(`uptime=${Math.floor(info.uptimeMs / 1000)}s`);
  parts.push(`token=${info.tokenFingerprint}`);
  parts.push(`running=${info.running ? 'yes' : 'no'}`);
  stdout(parts.join('  ') + '\n');
  return 0;
}
