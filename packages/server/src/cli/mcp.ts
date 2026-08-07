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
 *   4. Read stdio JSON-RPC frames; each valid frame becomes exactly one
 *      authenticated POST to the pinned `/mcp` endpoint, dispatched
 *      CONCURRENTLY so a long-blocking call (mma_task_wait) cannot starve
 *      later frames such as the execution App's polls. The
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
import { isLoopbackAddress, type CallerClient } from '@zhixuan92/multi-model-agent-core';

/** A single resolved DNS answer — the subset of `dns.lookup(host, {all:true})` we need. */
interface ResolvedAddress {
  address: string;
}

/**
 * Dependencies for `runMcpBridge`. Every piece of I/O and DNS behavior is
 * injected so tests are fully deterministic (no real network, no real DNS,
 * no real filesystem).
 */
interface McpBridgeDeps {
  /** The daemon base URL (already resolved via buildServerUrl + loadConfig). */
  daemonUrl: string;
  /** Environment variables (for MMA_AUTH_TOKEN / MMA_TOKEN_FILE lookup). */
  env: Record<string, string | undefined>;
  /** Home directory, used for the default `~/.mma/auth-token` fallback. */
  homeDir: string;
  /**
   * Which client this bridge is speaking for, forwarded as `X-MMA-Client` so
   * the daemon attributes the run to a real client instead of `other`.
   *
   * Optional on purpose: an existing registration that predates the flag (and
   * every hand-written `mma mcp` entry) keeps working and simply attributes as
   * `other`, exactly as it did before. The header is the ONLY way the daemon
   * can tell an Agent-Plugins client apart from a bespoke one, so every
   * generated registration sets it.
   */
  callerClient?: CallerClient;
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
  /** Per-frame upper bound in ms (POST + SSE body read). Defaults to
   *  {@link FRAME_TIMEOUT_MS}; tests override it so the abandon path is coverable
   *  without waiting two minutes. */
  frameTimeoutMs?: number;
}

type JsonRpcId = string | number | null;

/** Upper bound on ONE forwarded frame — the POST plus reading its SSE body. Frames are
 *  forwarded concurrently, so this bounds each one independently rather than protecting
 *  later frames from an earlier stall. Generous enough for a slow local daemon while still
 *  guaranteeing every frame terminates. */
const FRAME_TIMEOUT_MS = 120_000;

/** Cap on stdin lines held while a frame is in flight. Unbounded queuing plus a stalled
 *  upstream would let a fast client grow the bridge's memory without limit. Overflow is
 *  reported and dropped rather than silently retained. */
const MAX_QUEUED_LINES = 1024;

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
 * and return the unwrapped JSON payload. A single message's JSON payload may
 * be wrapped across several consecutive `data:` lines (large replies, e.g. an
 * inlined HTML resource) that must be reassembled — prefix-stripped, trimmed,
 * and concatenated back into one JSON text — before parsing. Collection stops
 * at the first blank line or first non-`data:` line following the selected
 * `event: message` line. Throws if no `data:` line is found following
 * `event: message`, or if the reassembled content is not valid JSON.
 */
async function parseSseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messageIndex = lines.findIndex((line) => line === 'event: message');
  const dataLines: string[] = [];
  if (messageIndex !== -1) {
    for (const line of lines.slice(messageIndex + 1)) {
      if (!line.startsWith('data:')) break;
      // Per the SSE specification, a field's value is the text after the colon with
      // exactly ONE leading space removed — not a full trim, which would destroy
      // significant whitespace inside the payload.
      const value = line.slice('data:'.length);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) {
    throw new Error('missing SSE data payload');
  }
  // Join with '\n', per the SSE specification — NOT by concatenation.
  //
  // This matters and is easy to get backwards: a producer splits a payload across
  // `data:` lines precisely BECAUSE the payload contains newlines (a pretty-printed
  // JSON document, say), and the receiver reconstructs it by rejoining with '\n'.
  // A producer never splits at an arbitrary byte offset mid-token, because that
  // would be corrupted by the very join the spec mandates. Concatenating instead
  // would silently mangle any payload whose own newlines are significant.
  return JSON.parse(dataLines.join('\n'));
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
  let dropped = 0;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  source.on('line', (line: string) => {
    // Bounded: a client that keeps writing while one frame is stalled upstream must not
    // be able to grow this array without limit.
    if (queue.length >= MAX_QUEUED_LINES) {
      dropped += 1;
      if (dropped === 1) {
        process.stderr.write(`mma mcp: more than ${MAX_QUEUED_LINES} frames queued; dropping further input until the backlog drains\n`);
      }
      return;
    }
    queue.push(line);
    signal();
  });
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
  //
  // Frames are dispatched CONCURRENTLY, not one at a time. JSON-RPC multiplexes on `id`, so
  // a response may arrive in any order, and the host correlates it — nothing here needs to
  // preserve arrival order.
  //
  // Serializing them was a real, user-visible bug rather than a missed optimisation. A single
  // `mma_task_wait` legitimately blocks for up to 55s server-side; with a sequential loop it
  // also blocked every LATER frame, including the execution App's own `mma_task_get` polls.
  // The App's per-poll timeout then fired and it displayed "update failed" while the daemon
  // was perfectly healthy — the long-poll starved the very monitor that exists to show
  // progress during long polls. Observed on Claude Desktop.
  const inFlight = new Set<Promise<void>>();

  /** Bound concurrent forwards so a pathological client cannot open unbounded sockets. */
  const MAX_IN_FLIGHT = 32;

  async function forwardFrame(frame: Record<string, unknown>, id: JsonRpcId, hasId: boolean): Promise<void> {
    // Bound every forwarded frame: a daemon that accepts a request and then never completes
    // the response would otherwise leave this promise pending forever. The timeout covers
    // both the fetch AND the response-body read.
    const frameBudgetMs = deps.frameTimeoutMs ?? FRAME_TIMEOUT_MS;
    const frameTimeout = new AbortController();
    const frameTimer = setTimeout(() => frameTimeout.abort(), frameBudgetMs);
    let res: Response;
    try {
      res = await deps.fetch(mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Host: '127.0.0.1',
          // Absent when the bridge was started without --client: the daemon
          // then falls back to `other`, which is what every pre-flag
          // registration already produced.
          ...(deps.callerClient !== undefined && { 'X-MMA-Client': deps.callerClient }),
        },
        body: JSON.stringify(frame),
        signal: frameTimeout.signal,
      });
    } catch (err) {
      clearTimeout(frameTimer);
      if (frameTimeout.signal.aborted) {
        stderr(redact(`mma mcp: request ${String(id)} exceeded ${frameBudgetMs}ms with no response from the daemon; abandoning this frame.\n`));
        if (hasId) {
          writeProtocol(errorFrame(id, -32603, `The daemon did not respond within ${frameBudgetMs}ms.`) + '\n');
        }
        return;
      }
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
      return;
    }

    if (!res.ok) {
      clearTimeout(frameTimer);
      if (hasId) {
        writeProtocol(
          errorFrame(id, -32603, `Upstream request failed`, { httpStatus: res.status }) + '\n',
        );
      }
      return;
    }

    // The timer is still armed here on purpose: reading the SSE body is part of the
    // same bounded frame, so a response whose body never completes also aborts.
    let payload: unknown;
    try {
      payload = await parseSseJson(res);
    } catch (err) {
      const timedOut = frameTimeout.signal.aborted;
      clearTimeout(frameTimer);
      if (hasId) {
        writeProtocol(errorFrame(
          id,
          -32603,
          timedOut ? `The daemon did not finish the response within ${frameBudgetMs}ms.` : 'Malformed upstream response',
        ) + '\n');
      }
      return;
    }
    clearTimeout(frameTimer);

    // Notifications (no `id`) never get a response, per JSON-RPC 2.0 —
    // even though we still forwarded them as their own independent POST.
    if (hasId) {
      writeProtocol(JSON.stringify(payload) + '\n');
    }
  }

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

    // Dispatch without awaiting, so a slow frame never delays the next one. Each forward
    // already bounds itself and converts its own failures into a JSON-RPC error frame, so
    // nothing here can reject — the catch is belt-and-braces against a future edit.
    const task = forwardFrame(frame, id, hasId).catch(() => undefined);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));

    // Backpressure: past the cap, wait for any one forward to settle before reading more.
    // Reading stdin unboundedly while upstream stalls is how a fast client turns into
    // unbounded memory and socket use.
    if (inFlight.size >= MAX_IN_FLIGHT) {
      await Promise.race(inFlight);
    }
  }

  // stdin closed: let every forward already accepted finish writing its response before the
  // process exits, or a client that closes the pipe promptly loses answers it is owed.
  await Promise.allSettled(inFlight);

  return 0;
}
