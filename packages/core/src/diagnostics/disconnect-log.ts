import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

export type ShutdownCause =
  | 'stdin_end'
  | 'stdout_epipe'
  | 'stdout_other_error'
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'SIGTERM'
  | 'SIGINT'
  | 'SIGPIPE'
  | 'SIGHUP'
  | 'SIGABRT'
  | 'event_loop_empty';

export interface DiagnosticLogger {
  startup(version: string): void;
  requestStart(params: {
    tool: string;
    requestId: string;
  }): void;
  requestComplete(params: {
    tool: string;
    requestId: string;
    durationMs: number;
    responseBytes: number;
    status: 'ok' | 'error';
  }): void;
  error(kind: string, err: unknown): void;
  shutdown(cause: ShutdownCause): void;
  expectedPath(): string | undefined;
}

export interface CreateDiagnosticLoggerOptions {
  logDir?: string;
  now?: () => Date;
  openSync?: (path: string, flags: string, mode: number) => number;
  closeSync?: (fd: number) => void;
  writeSync?: (fd: number, data: string) => void;
  mkdirSync?: (path: string, options: { recursive: true; mode: number }) => void;
  stderrWrite?: (data: string) => void;
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

function normaliseError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      ...(typeof err.stack === 'string' && err.stack.length > 0 ? { stack: err.stack } : {}),
    };
  }
  if (typeof err === 'string') return { message: err };
  if (err === null) return { message: 'null' };
  if (err === undefined) return { message: 'undefined' };
  return { message: safeStringify(err) };
}

export function createDiagnosticLogger(
  options: CreateDiagnosticLoggerOptions = {},
): DiagnosticLogger {
  const enabled = isTruthyEnvValue(process.env.MCP_DIAGNOSTIC_LOG);
  const logDir = process.env.MCP_DIAGNOSTIC_LOG_DIR
    ?? options.logDir
    ?? nodePath.join(nodeOs.homedir(), '.multi-model', 'logs');
  const now = options.now ?? (() => new Date());
  const openSync = options.openSync ?? nodeFs.openSync;
  const closeSync = options.closeSync ?? nodeFs.closeSync;
  const writeSync = options.writeSync ?? ((fd: number, data: string) => {
    nodeFs.writeSync(fd, data);
  });
  const mkdirSync = options.mkdirSync ?? nodeFs.mkdirSync;
  const stderrWrite = options.stderrWrite ?? ((data: string) => {
    process.stderr.write(data);
  });

  if (!enabled) {
    return {
      startup: () => {},
      requestStart: () => {},
      requestComplete: () => {},
      error: () => {},
      shutdown: () => {},
      expectedPath: () => undefined,
    };
  }

  const processStartTime = now().getTime();
  const inFlight = new Map<string, { tool: string; startedAt: string; startedAtMs: number }>();
  const state: {
    fd: number | null;
    fdDate: string | null;
    inert: boolean;
    startupEmitted: boolean;
    shutdownEmitted: boolean;
    warned: boolean;
  } = {
    fd: null,
    fdDate: null,
    inert: false,
    startupEmitted: false,
    shutdownEmitted: false,
    warned: false,
  };

  function disable(reason: string): void {
    if (state.warned) return;
    state.warned = true;
    state.inert = true;
    if (state.fd !== null) {
      try { closeSync(state.fd); } catch { /* noop */ }
    }
    state.fd = null;
    state.fdDate = null;
    stderrWrite(`[diagnostic-log] disabled: ${reason}\n`);
  }

  function ensureOpen(): number | null {
    if (state.inert) return null;
    const today = formatUtcDate(now());
    if (state.fd !== null && state.fdDate === today) return state.fd;
    try {
      if (state.fd !== null && state.fdDate !== today) {
        try { closeSync(state.fd); } catch { /* noop */ }
      }
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const fd = openSync(nodePath.join(logDir, `mcp-${today}.jsonl`), 'a', 0o600);
      state.fd = fd;
      state.fdDate = today;
      return fd;
    } catch (err) {
      disable(normaliseError(err).message);
      return null;
    }
  }

  function writeLine(obj: Record<string, unknown>): void {
    if (state.inert) return;
    const fd = ensureOpen();
    if (fd === null) return;
    try {
      writeSync(fd, `${JSON.stringify(obj)}\n`);
    } catch (err) {
      disable(normaliseError(err).message);
    }
  }

  return {
    startup: (version) => {
      if (state.inert || state.startupEmitted) return;
      state.startupEmitted = true;
      writeLine({
        event: 'startup',
        ts: now().toISOString(),
        pid: process.pid,
        version,
      });
    },
    requestStart: ({ requestId, tool }) => {
      if (state.inert) return;
      const startedAt = now();
      if (inFlight.has(requestId)) {
        writeLine({
          event: 'error',
          ts: startedAt.toISOString(),
          kind: 'duplicate_request_id',
          message: `requestStart called twice for requestId=${requestId}; previous in-flight entry replaced`,
        });
      }
      inFlight.set(requestId, {
        tool,
        startedAt: startedAt.toISOString(),
        startedAtMs: startedAt.getTime(),
      });
      writeLine({
        event: 'request_start',
        ts: startedAt.toISOString(),
        requestId,
        tool,
      });
    },
    requestComplete: ({ requestId, tool, durationMs, responseBytes, status }) => {
      if (state.inert) return;
      inFlight.delete(requestId);
      writeLine({
        event: 'request_complete',
        ts: now().toISOString(),
        requestId,
        tool,
        durationMs,
        status,
        responseBytes,
      });
    },
    error: (kind, err) => {
      if (state.inert) return;
      const normalised = normaliseError(err);
      writeLine({
        event: 'error',
        ts: now().toISOString(),
        kind,
        message: normalised.message,
        ...(normalised.stack !== undefined ? { stack: normalised.stack } : {}),
      });
    },
    shutdown: (cause) => {
      if (state.inert || state.shutdownEmitted) return;
      state.shutdownEmitted = true;
      const ts = now();
      let lastRequestInFlight:
        | { requestId: string; tool: string; startedAt: string }
        | undefined;
      for (const [requestId, entry] of inFlight.entries()) {
        if (!lastRequestInFlight || entry.startedAtMs > inFlight.get(lastRequestInFlight.requestId)!.startedAtMs) {
          lastRequestInFlight = {
            requestId,
            tool: entry.tool,
            startedAt: entry.startedAt,
          };
        }
      }
      writeLine({
        event: 'shutdown',
        ts: ts.toISOString(),
        cause,
        uptimeMs: ts.getTime() - processStartTime,
        ...(lastRequestInFlight !== undefined ? { lastRequestInFlight } : {}),
      });
    },
    expectedPath: () => {
      if (state.inert) return undefined;
      return nodePath.join(logDir, `mcp-${formatUtcDate(now())}.jsonl`);
    },
  };
}
