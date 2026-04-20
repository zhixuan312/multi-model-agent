export type ShutdownCause =
  | 'stdout_epipe'
  | 'stdout_other_error'
  | 'stdin_end'
  | 'uncaughtException';

export type NonTerminalErrorCause = 'unhandledRejection';

export interface DiagnosticLogger {
  request(params: {
    tool: string;
    requestId: string | undefined;
    progressToken: string | number | undefined;
    durationMs: number;
    responseBytes: number;
    status: 'ok' | 'error';
  }): void;
  notification(headline: string, succeeded: boolean): void;
  logError(cause: NonTerminalErrorCause, err: unknown): void;
  shutdown(cause: ShutdownCause, err?: unknown): void;
  expectedPath(): string;
}

export interface CreateDiagnosticLoggerOptions {
  logDir?: string;
  now?: () => Date;
  openSync?: (path: string, flags: string, mode: number) => number;
  closeSync?: (fd: number) => void;
  writeSync?: (fd: number, data: string) => void;
  mkdirSync?: (path: string, options: { recursive: true; mode: number }) => void;
}

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createDiagnosticLogger(
  options: CreateDiagnosticLoggerOptions = {},
): DiagnosticLogger {
  const logDir = options.logDir ?? nodePath.join(nodeOs.homedir(), '.multi-model', 'logs');
  const now = options.now ?? (() => new Date());
  const openSync = options.openSync ?? nodeFs.openSync;
  const closeSync = options.closeSync ?? nodeFs.closeSync;
  const writeSync = options.writeSync ?? ((fd: number, data: string) => {
    nodeFs.writeSync(fd, data);
  });
  const mkdirSync = options.mkdirSync ?? nodeFs.mkdirSync;

  const state: {
    fd: number | null;
    fdDate: string | null;
    broken: boolean;
  } = { fd: null, fdDate: null, broken: false };

  const notifState: {
    attempted: number;
    succeeded: number;
    lastHeadline: string | null;
    sinceIso: string;
    interval: ReturnType<typeof setInterval> | null;
  } = {
    attempted: 0,
    succeeded: 0,
    lastHeadline: null,
    sinceIso: now().toISOString(),
    interval: null,
  };

  function flushNotificationBatch(): void {
    if (notifState.attempted === 0) {
      if (notifState.interval !== null) {
        clearInterval(notifState.interval);
        notifState.interval = null;
      }
      return;
    }
    const ts = now().toISOString();
    writeLine({
      ts,
      pid: process.pid,
      event: 'notification_batch',
      since: notifState.sinceIso,
      attempted: notifState.attempted,
      succeeded: notifState.succeeded,
      lastHeadline: notifState.lastHeadline,
    });
    notifState.sinceIso = ts;
    notifState.attempted = 0;
    notifState.succeeded = 0;
    notifState.lastHeadline = null;
  }

  function ensureNotifInterval(): void {
    if (notifState.interval !== null) return;
    const timer = setInterval(flushNotificationBatch, 5000);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    notifState.interval = timer;
  }

  function ensureOpen(): number | null {
    if (state.broken) return null;
    const today = formatUtcDate(now());
    if (state.fd !== null && state.fdDate === today) return state.fd;
    try {
      if (state.fd !== null && state.fdDate !== today) {
        try { closeSync(state.fd); } catch { /* tolerate fd leak */ }
      }
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const fd = openSync(nodePath.join(logDir, `mcp-${today}.jsonl`), 'a', 0o600);
      state.fd = fd;
      state.fdDate = today;
      return fd;
    } catch {
      state.broken = true;
      state.fd = null;
      state.fdDate = null;
      return null;
    }
  }

  function writeLine(obj: Record<string, unknown>): void {
    if (state.broken) return;
    const fd = ensureOpen();
    if (fd === null) return;
    try {
      writeSync(fd, JSON.stringify(obj) + '\n');
    } catch {
      try { closeSync(fd); } catch { /* tolerate close failure */ }
      state.broken = true;
      state.fd = null;
      state.fdDate = null;
    }
  }

  return {
    request: (params) => {
      const line: Record<string, unknown> = {
        ts: now().toISOString(),
        pid: process.pid,
        event: 'request',
        tool: params.tool,
        durationMs: params.durationMs,
        responseBytes: params.responseBytes,
        status: params.status,
      };
      if (params.requestId !== undefined) line.requestId = params.requestId;
      if (params.progressToken !== undefined) line.progressToken = params.progressToken;
      writeLine(line);
    },
    notification: (headline, succeeded) => {
      notifState.attempted += 1;
      if (succeeded) notifState.succeeded += 1;
      notifState.lastHeadline = headline;
      ensureNotifInterval();
    },
    logError: () => { throw new Error('Task 5'); },
    shutdown: () => { throw new Error('Task 5'); },
    expectedPath: () => nodePath.join(logDir, `mcp-${formatUtcDate(now())}.jsonl`),
  };
}
