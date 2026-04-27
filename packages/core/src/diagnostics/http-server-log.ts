import type { ShutdownCause, SessionCloseReason } from './types.js';
import type { JsonlWriter } from './jsonl-writer.js';

export type { ShutdownCause, SessionCloseReason };

export interface HttpServerLog {
  startup(version: string, extras?: { transport?: 'stdio' | 'http' }): void;
  requestStart(params: {
    tool: string;
    requestId: string;
    sessionId?: string;
    cwd?: string;
  }): void;
  requestComplete(params: {
    tool: string;
    requestId: string;
    durationMs: number;
    responseBytes: number;
    status: 'ok' | 'error';
    sessionId?: string;
    cwd?: string;
  }): void;
  error(kind: string, err: unknown): void;
  shutdown(cause: ShutdownCause): void;
  expectedPath(): string;

  sessionOpen(params: { sessionId: string; cwd: string; remoteAddr?: string }): void;
  sessionClose(params: { sessionId: string; cwd: string; reason: SessionCloseReason; durationMs: number }): void;
  connectionRejected(params: { reason: string; httpStatus: number; cwd?: string; remoteAddr?: string }): void;
  requestRejected(params: { reason: string; httpStatus: number; sessionIdAttempted?: string }): void;
  projectCreated(params: { cwd: string }): void;
  projectEvicted(params: { cwd: string; idleMs: number }): void;
}

export interface CreateHttpServerLogOptions {
  enabled: boolean;
  writer: JsonlWriter;
  now?: () => Date;
  stderrWrite?: (data: string) => void;
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
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

export function createHttpServerLog(
  options: CreateHttpServerLogOptions,
): HttpServerLog {
  const { enabled, writer, now, stderrWrite } = options;
  const getNow = now ?? (() => new Date());
  const warn = stderrWrite ?? ((_data: string) => {});

  if (!enabled) {
    return {
      startup: () => {},
      requestStart: () => {},
      requestComplete: () => {},
      error: () => {},
      shutdown: () => {},
      expectedPath: () => '',
      sessionOpen: () => {},
      sessionClose: () => {},
      connectionRejected: () => {},
      requestRejected: () => {},
      projectCreated: () => {},
      projectEvicted: () => {},
    };
  }

  const processStartTime = getNow().getTime();
  const inFlight = new Map<string, { tool: string; startedAt: string; startedAtMs: number }>();
  let startupEmitted = false;
  let shutdownEmitted = false;

  function writeLine(obj: Record<string, unknown>): void {
    writer.writeLine(obj);
  }

  return {
    startup: (version, extras) => {
      if (startupEmitted) return;
      startupEmitted = true;
      writeLine({
        event: 'startup',
        ts: getNow().toISOString(),
        pid: process.pid,
        version,
        transport: extras?.transport ?? 'stdio',
      });
    },
    requestStart: ({ requestId, tool, sessionId, cwd }) => {
      const startedAt = getNow();
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
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    },
    requestComplete: ({ requestId, tool, durationMs, responseBytes, status, sessionId, cwd }) => {
      inFlight.delete(requestId);
      writeLine({
        event: 'request_complete',
        ts: getNow().toISOString(),
        requestId,
        tool,
        durationMs,
        status,
        responseBytes,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    },
    error: (kind, err) => {
      const normalised = normaliseError(err);
      writeLine({
        event: 'error',
        ts: getNow().toISOString(),
        kind,
        message: normalised.message,
        ...(normalised.stack !== undefined ? { stack: normalised.stack } : {}),
      });
    },
    shutdown: (cause) => {
      if (shutdownEmitted) return;
      shutdownEmitted = true;
      const ts = getNow();
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
    expectedPath: () => writer.currentPath,
    sessionOpen: ({ sessionId, cwd, remoteAddr }) => {
      writeLine({
        event: 'session_open',
        ts: getNow().toISOString(),
        sessionId,
        cwd,
        ...(remoteAddr !== undefined ? { remoteAddr } : {}),
      });
    },
    sessionClose: ({ sessionId, cwd, reason, durationMs }) => {
      writeLine({
        event: 'session_close',
        ts: getNow().toISOString(),
        sessionId,
        cwd,
        reason,
        durationMs,
      });
    },
    connectionRejected: ({ reason, httpStatus, cwd, remoteAddr }) => {
      writeLine({
        event: 'connection_rejected',
        ts: getNow().toISOString(),
        reason,
        httpStatus,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(remoteAddr !== undefined ? { remoteAddr } : {}),
      });
    },
    requestRejected: ({ reason, httpStatus, sessionIdAttempted }) => {
      writeLine({
        event: 'request_rejected',
        ts: getNow().toISOString(),
        reason,
        httpStatus,
        ...(sessionIdAttempted !== undefined ? { sessionIdAttempted } : {}),
      });
    },
    projectCreated: ({ cwd }) => {
      writeLine({
        event: 'project_created',
        ts: getNow().toISOString(),
        cwd,
      });
    },
    projectEvicted: ({ cwd, idleMs }) => {
      writeLine({
        event: 'project_evicted',
        ts: getNow().toISOString(),
        cwd,
        idleMs,
      });
    },
  };
}
