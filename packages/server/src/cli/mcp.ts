/**
 * mcp.ts — `mma mcp` stdio bridge.
 *
 * Bridges a Desktop-style stdio MCP client to the already-running local mma
 * daemon's stateless `POST /mcp` endpoint. This module owns NO execution
 * state — it is a thin, security-focused forwarder:
 *
 *   1. At startup ONLY, resolve the configured daemon host to a numeric
 *      address exactly once, verify every resolved answer is loopback via
 *      `isLoopbackAddress`, and PIN the first validated address. Every
 *      later request URL is built from that pinned address — never from a
 *      fresh DNS lookup — so a DNS-rebind between requests cannot redirect
 *      the bearer token off-box.
 *   2. Run a `/health` preflight against the pinned address.
 *   3. Resolve a bearer token (env → token file → default token path).
 *   4. Read stdio JSON-RPC frames one at a time; each valid frame becomes
 *      exactly one authenticated POST to the pinned `/mcp` endpoint. The
 *      endpoint always replies as SSE (`event: message\ndata: {json}\n\n`);
 *      this module unwraps that to a single bare JSON line on stdout.
 *
 * Only startup failures (bad token, failed loopback validation/resolution,
 * failed health preflight) are fatal. Every failure after that point is
 * translated into a per-frame JSON-RPC error and processing continues.
 * stdout carries protocol frames ONLY — all diagnostics go to stderr, and
 * the resolved token is redacted from every formatted string this module
 * writes.
 *
 * This module imports nothing from `application/` and constructs no
 * ExecutionRuntime/ExecutionStore/provider — it only ever talks to the
 * daemon over HTTP, like any other MCP client would.
 */
import * as path from 'node:path';
import * as net from 'node:net';
import { isLoopbackAddress } from '@zhixuan92/multi-model-agent-core';

/** A single resolved DNS answer — the subset of `dns.lookup(host, {all:true})` we need. */
export interface ResolvedAddress {
  address: string;
}

/**
 * Dependencies for `runMcpBridge`. Every piece of I/O and DNS behavior is
 * injected so tests are fully deterministic (no real network, no real DNS,
 * no real filesystem).
 */
export interface McpBridgeDeps {
  /** The daemon base URL (already resolved via buildServerUrl + loadConfig). */
  daemonUrl: string;
  /** Environment variables (for MMA_AUTH_TOKEN / MMA_TOKEN_FILE lookup). */
  env: Record<string, string | undefined>;
  /** Home directory, used for the default `~/.mma/auth-token` fallback. */
  homeDir: string;
  /** Async iterable of raw stdin lines (one JSON-RPC frame per line). */
  stdin: AsyncIterable<string>;
  /** Write a line to stdout. */
  stdout: (s: string) => boolean;
  /** Write a line to stderr. */
  stderr: (s: string) => boolean;
  /** Injectable fetch. */
  fetch: typeof fetch;
  /**
   * Resolve a hostname to its numeric addresses. Called AT MOST ONCE per
   * bridge run — only when the configured host is not already a numeric
   * IP literal.
   */
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * Read a token file's raw contents (sync). May throw (e.g. ENOENT) — the
   * caller treats a throw as "unusable" and falls through to the next
   * token source.
   */
  readFile: (filePath: string) => string;
}

type JsonRpcId = string | number | null;

interface JsonRpcErrorFrame {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

/** Build a redaction function that strips a known secret from formatted output. */
function makeRedactor(token: string): (s: string) => string {
  if (!token) return (s: string) => s;
  const jsonEscapedToken = JSON.stringify(token).slice(1, -1);
  const forms = [...new Set([token, jsonEscapedToken])];
  return (s: string) => forms.reduce((redacted, form) => redacted.split(form).join('[redacted]'), s);
}

/** True iff `value` is a well-formed (non-array) JSON-RPC 2.0 request/notification object. */
function isJsonRpcObject(value: unknown): value is Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    record['jsonrpc'] === '2.0' &&
    typeof record['method'] === 'string' &&
    (!Object.prototype.hasOwnProperty.call(record, 'id') ||
      record['id'] === null ||
      typeof record['id'] === 'string' ||
      typeof record['id'] === 'number')
  );
}

/** Format an error response line for stdout. */
function errorFrame(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  const frame: JsonRpcErrorFrame = { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  return JSON.stringify(frame);
}

/**
 * Resolve the bearer token using the documented precedence:
 *   1. $MMA_AUTH_TOKEN (first nonblank value)
 *   2. contents of the file at $MMA_TOKEN_FILE
 *   3. contents of `<homeDir>/.mma/auth-token`
 * Returns an error message (naming all three sources) if none are usable.
 */
function resolveToken(deps: McpBridgeDeps): { token: string } | { error: string } {
  const envToken = (deps.env['MMA_AUTH_TOKEN'] ?? '').trim();
  if (envToken) return { token: envToken };

  const tokenFileEnv = (deps.env['MMA_TOKEN_FILE'] ?? '').trim();
  if (tokenFileEnv) {
    try {
      const contents = deps.readFile(tokenFileEnv).trim();
      if (contents) return { token: contents };
    } catch {
      // fall through to the default token path
    }
  }

  const defaultTokenPath = path.join(deps.homeDir, '.mma', 'auth-token');
  try {
    const contents = deps.readFile(defaultTokenPath).trim();
    if (contents) return { token: contents };
  } catch {
    // fall through to the final error below
  }

  return {
    error:
      `mma mcp: no usable auth token found. Checked $MMA_AUTH_TOKEN, the file at ` +
      `$MMA_TOKEN_FILE, and ${defaultTokenPath}. Set MMA_AUTH_TOKEN, set MMA_TOKEN_FILE, ` +
      `or run 'mma print-token' first.`,
  };
}

/**
 * Resolve the daemon URL's host to a single pinned numeric loopback address.
 * Performs DNS resolution AT MOST ONCE (skipped entirely when the host is
 * already a numeric IP literal). Every resolved answer must be loopback;
 * any non-loopback answer is fatal.
 */
async function resolvePinnedHost(
  hostname: string,
  deps: Pick<McpBridgeDeps, 'resolveHost'>,
): Promise<{ pinned: string } | { error: string }> {
  const numericCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(numericCandidate)) {
    if (isLoopbackAddress(numericCandidate)) return { pinned: numericCandidate };
    return { error: `mma mcp: refusing non-loopback daemon host '${hostname}'.` };
  }

  let answers: ResolvedAddress[];
  try {
    answers = await deps.resolveHost(numericCandidate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `mma mcp: failed to resolve daemon host '${hostname}': ${msg}` };
  }

  if (!answers || answers.length === 0) {
    return { error: `mma mcp: DNS resolution for '${hostname}' returned no addresses.` };
  }

  for (const answer of answers) {
    if (net.isIP(answer.address) === 0) {
      return {
        error: `mma mcp: refusing non-numeric DNS answer for '${hostname}': ${answer.address}`,
      };
    }
    if (!isLoopbackAddress(answer.address)) {
      return {
        error: `mma mcp: refusing non-loopback DNS answer for '${hostname}': ${answer.address}`,
      };
    }
  }

  return { pinned: answers[0]!.address };
}

/**
 * Parse the daemon's SSE-only `/mcp` reply (`event: message\ndata: {json}\n\n`)
 * and return the unwrapped JSON payload. Throws if no `data:` line is found
 * or its content is not valid JSON.
 */
async function parseSseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messageIndex = lines.findIndex((line) => line === 'event: message');
  const dataLine = messageIndex === -1
    ? undefined
    : lines.slice(messageIndex + 1).find((line) => line.startsWith('data:'));
  if (dataLine === undefined) {
    throw new Error('missing SSE data payload');
  }
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

/**
 * Run the stdio↔HTTP MCP bridge. Resolves to a process exit code: `0` only
 * after stdin reaches EOF; nonzero for any of the three fatal startup
 * failures (bad token, failed loopback validation/resolution, failed health
 * preflight). Every failure once frames are being processed is reported as
 * a per-frame JSON-RPC error and does not stop the loop.
 */
/**
 * Buffer every line a readline interface emits, from the moment it is created.
 *
 * `readline.createInterface()` starts consuming its input immediately, but
 * {@link runMcpBridge} only begins iterating AFTER its async startup (token
 * resolution, DNS pinning, health preflight). Lines emitted during that window are
 * delivered to no one and silently lost — and because a host writes its `initialize`
 * frame the instant it spawns the bridge, that race is the common case rather than an
 * edge case. Piping input loses every frame.
 *
 * Iterating the interface directly is therefore unsafe here. This wraps it so lines
 * are queued as they arrive and handed over once iteration starts.
 */
export function bufferedLines(source: {
  on(event: 'line', listener: (line: string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}): AsyncIterable<string> {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  source.on('line', (line: string) => { queue.push(line); signal(); });
  source.on('close', () => { closed = true; signal(); });

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}

export async function runMcpBridge(deps: McpBridgeDeps): Promise<number> {
  const { stdout, stderr } = deps;

  // ── 1. Token (fatal before any network I/O) ───────────────────────────
  const tokenResult = resolveToken(deps);
  if ('error' in tokenResult) {
    stderr(`${tokenResult.error}\n`);
    return 1;
  }
  const token = tokenResult.token;
  const redact = makeRedactor(token);
  const writeProtocol = (line: string): boolean => stdout(redact(line));

  // ── 2. Parse the configured URL and pin its host (fatal) ─────────────
  let configuredUrl: URL;
  try {
    configuredUrl = new URL(deps.daemonUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(redact(`mma mcp: invalid daemon URL '${deps.daemonUrl}': ${msg}\n`));
    return 1;
  }

  const pinResult = await resolvePinnedHost(configuredUrl.hostname, deps);
  if ('error' in pinResult) {
    stderr(redact(`${pinResult.error}\n`));
    return 1;
  }
  const pinned = pinResult.pinned;

  const pinnedUrl = new URL(configuredUrl.toString());
  pinnedUrl.hostname = pinned;
  const origin = pinnedUrl.origin;
  const mcpUrl = `${origin}/mcp`;

  // ── 3. Health preflight against the pinned address (fatal) ───────────
  try {
    const healthRes = await deps.fetch(`${origin}/health`, {
      method: 'GET',
      headers: { Host: '127.0.0.1' },
    });
    if (!healthRes.ok) {
      stderr(
        redact(
          `mma mcp: daemon health check at ${origin} failed (HTTP ${healthRes.status}). ` +
            `Is the daemon running? Start it with 'mma serve'.\n`,
        ),
      );
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(
      redact(
        `mma mcp: cannot reach daemon at ${origin}: ${msg}. Start it with 'mma serve'.\n`,
      ),
    );
    return 1;
  }

  // ── 4. Process stdin frames — each is exactly one independent POST ───
  for await (const rawLine of deps.stdin) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeProtocol(errorFrame(null, -32700, 'Parse error') + '\n');
      continue;
    }

    if (!isJsonRpcObject(parsed)) {
      writeProtocol(errorFrame(null, -32600, 'Invalid Request') + '\n');
      continue;
    }

    const frame = parsed;
    const hasId = Object.prototype.hasOwnProperty.call(frame, 'id');
    const id: JsonRpcId = hasId ? (frame['id'] as JsonRpcId) : null;

    let res: Response;
    try {
      res = await deps.fetch(mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Host: '127.0.0.1',
        },
        body: JSON.stringify(frame),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(
        redact(
          `mma mcp: lost connection to the daemon while forwarding request ${String(id)}: ${msg}. ` +
            `Is it still running? Start it with 'mma serve'.\n`,
        ),
      );
      if (hasId) {
        writeProtocol(
          errorFrame(
            id,
            -32603,
            `Lost connection to the daemon. Is it still running? Start it with 'mma serve'.`,
          ) + '\n',
        );
      }
      continue;
    }

    if (!res.ok) {
      if (hasId) {
        writeProtocol(
          errorFrame(id, -32603, `Upstream request failed`, { httpStatus: res.status }) + '\n',
        );
      }
      continue;
    }

    let payload: unknown;
    try {
      payload = await parseSseJson(res);
    } catch {
      if (hasId) {
        writeProtocol(errorFrame(id, -32603, 'Malformed upstream response') + '\n');
      }
      continue;
    }

    // Notifications (no `id`) never get a response, per JSON-RPC 2.0 —
    // even though we still forwarded them as their own independent POST.
    if (hasId) {
      writeProtocol(JSON.stringify(payload) + '\n');
    }
  }

  return 0;
}
