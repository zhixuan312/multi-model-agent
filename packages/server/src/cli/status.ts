/**
 * status.ts — `mmagent status` subcommand.
 *
 * Fetches GET /status from a running server and pretty-prints a summary.
 * Supports --json to dump the raw JSON response.
 * Exits 1 if the server is unreachable or returns an error status.
 *
 * Usage:
 *   mmagent status [--config <path>] [--json]
 */
import * as os from 'node:os';
import * as path from 'node:path';

/** Shape returned by GET /status — we only define what we use. */
interface StatusResponse {
  version?: string;
  uptimeMs?: number;
  pid?: number;
  bind?: string;
  counters?: {
    projectCount?: number;
    activeRequests?: number;
    activeBatches?: number;
  };
  inflight?: unknown[];
  recent?: unknown[];
  skillVersion?: string | null;
  skillCompatible?: boolean | null;
}

export interface StatusDeps {
  /** Server URL (e.g. 'http://127.0.0.1:7337'). */
  serverUrl: string;
  /** Bearer auth token. */
  token: string;
  /** Output as raw JSON instead of pretty-printed summary. */
  json?: boolean;
  /** Write to stdout. */
  stdout?: (s: string) => boolean;
  /** Write to stderr. */
  stderr?: (s: string) => boolean;
  /** Inject fetch for testability. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Format uptime in ms as a human-readable string.
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Fetch GET /status and print a summary (or raw JSON).
 * Returns an exit code: 0 on success, 1 on error.
 */
export async function fetchStatus(deps: StatusDeps): Promise<number> {
  const { serverUrl, token, json = false } = deps;
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const fetcher = deps.fetch ?? fetch;

  const url = `${serverUrl.replace(/\/$/, '')}/status`;

  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`mmagent status: cannot reach server at ${serverUrl}: ${msg}\n`);
    stderr(`Is the server running? Start it with 'mmagent serve'.\n`);
    return 1;
  }

  if (!res.ok) {
    stderr(`mmagent status: server returned HTTP ${res.status} ${res.statusText}\n`);
    return 1;
  }

  let body: StatusResponse;
  try {
    body = (await res.json()) as StatusResponse;
  } catch (err) {
    stderr(`mmagent status: invalid JSON response from server\n`);
    return 1;
  }

  if (json) {
    stdout(JSON.stringify(body, null, 2) + '\n');
    return 0;
  }

  // Pretty-print summary
  const lines: string[] = [];
  lines.push(`mmagent server status`);
  lines.push(`─────────────────────────────`);
  if (body.version) lines.push(`  version:        ${body.version}`);
  if (body.pid !== undefined) lines.push(`  pid:            ${body.pid}`);
  if (body.bind) lines.push(`  bind:           ${body.bind}`);
  if (body.uptimeMs !== undefined) lines.push(`  uptime:         ${formatUptime(body.uptimeMs)}`);

  const c = body.counters;
  if (c) {
    lines.push(`  projects:       ${c.projectCount ?? 0}`);
    lines.push(`  active batches: ${c.activeBatches ?? 0}`);
    lines.push(`  active reqs:    ${c.activeRequests ?? 0}`);
  }

  const inflightCount = Array.isArray(body.inflight) ? body.inflight.length : 0;
  lines.push(`  in-flight:      ${inflightCount}`);

  if (body.skillVersion !== undefined) {
    const sv = body.skillVersion ?? 'none';
    const compat = body.skillCompatible === true ? ' (compatible)'
      : body.skillCompatible === false ? ' (incompatible — run mmagent install-skill to update)'
        : '';
    lines.push(`  skill version:  ${sv}${compat}`);
  }

  stdout(lines.join('\n') + '\n');
  return 0;
}

/**
 * Build the server URL from a bind address and port.
 * Handles '0.0.0.0' / '::' by converting to '127.0.0.1' since /status
 * is loopback-only.
 */
export function buildServerUrl(bind: string, port: number): string {
  const host = (bind === '0.0.0.0' || bind === '::') ? '127.0.0.1' : bind;
  return `http://${host}:${port}`;
}

export interface RunStatusDeps {
  /** Config with server.bind + server.port. */
  serverUrl: string;
  /** Token file path (already resolved). */
  tokenFile: string;
  /** Whether to output raw JSON. */
  json?: boolean;
  /** Environment variable accessor (for MMAGENT_AUTH_TOKEN override). */
  env?: Record<string, string | undefined>;
  /** Write to stdout. */
  stdout?: (s: string) => boolean;
  /** Write to stderr. */
  stderr?: (s: string) => boolean;
  /** Inject fetch for testability. */
  fetch?: typeof fetch;
  /** Home directory (used to expand token file paths). */
  homeDir?: string;
}

/**
 * Read the token and then call fetchStatus.
 * Returns exit code.
 */
export async function runStatus(deps: RunStatusDeps): Promise<number> {
  const { serverUrl, tokenFile, json = false } = deps;
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const homeDir = deps.homeDir ?? os.homedir();

  // Read the token (env wins)
  let token: string;
  const envToken = (env['MMAGENT_AUTH_TOKEN'] ?? '').trim();
  if (envToken.length > 0) {
    token = envToken;
  } else {
    const { readFileSync } = await import('node:fs');
    const resolvedTokenFile = tokenFile.startsWith('~/')
      ? path.join(homeDir, tokenFile.slice(2))
      : tokenFile;
    try {
      token = readFileSync(resolvedTokenFile, 'utf-8').trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        stderr(`mmagent status: token file not found: ${resolvedTokenFile}\n`);
        stderr(`Run 'mmagent print-token' or set MMAGENT_AUTH_TOKEN.\n`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`mmagent status: cannot read token file: ${msg}\n`);
      }
      return 1;
    }
  }

  return fetchStatus({
    serverUrl,
    token,
    json,
    stdout: deps.stdout,
    stderr: deps.stderr,
    fetch: deps.fetch,
  });
}
