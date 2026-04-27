import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import type {
  ShutdownCause,
  SessionCloseReason,
  EventPrimitive,
  TaskEvent,
  DiagLoop,
  DiagRole,
  DiagReason,
  EscalationEventParams,
  EscalationUnavailableEventParams,
  FallbackEventParams,
  FallbackUnavailableEventParams,
} from './types.js';

export type {
  ShutdownCause,
  SessionCloseReason,
  EventPrimitive,
  TaskEvent,
  DiagLoop,
  DiagRole,
  DiagReason,
  EscalationEventParams,
  EscalationUnavailableEventParams,
  FallbackEventParams,
  FallbackUnavailableEventParams,
};

export interface DiagnosticLogger {
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
  expectedPath(): string | undefined;

  // HTTP-only (callable on stdio logger too; they're no-ops when disabled)
  sessionOpen(params: { sessionId: string; cwd: string; remoteAddr?: string }): void;
  sessionClose(params: { sessionId: string; cwd: string; reason: SessionCloseReason; durationMs: number }): void;
  connectionRejected(params: { reason: string; httpStatus: number; cwd?: string; remoteAddr?: string }): void;
  requestRejected(params: { reason: string; httpStatus: number; sessionIdAttempted?: string }): void;
  projectCreated(params: { cwd: string }): void;
  projectEvicted(params: { cwd: string; idleMs: number }): void;

  // Task lifecycle events (3.1.0)
  taskStarted(params: { batchId: string; taskIndex: number; worker?: string }): void;
  emit(event: TaskEvent): void;
  batchCompleted(params: { batchId: string; tool: string; durationMs: number; taskCount: number }): void;
  batchFailed(params: { batchId: string; tool: string; durationMs: number; errorCode: string; errorMessage: string }): void;

  escalation(params: EscalationEventParams): void;
  escalationUnavailable(params: EscalationUnavailableEventParams): void;
  fallback(params: FallbackEventParams): void;
  fallbackUnavailable(params: FallbackUnavailableEventParams): void;
}

export interface CreateDiagnosticLoggerOptions {
  enabled: boolean;
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
  options: CreateDiagnosticLoggerOptions,
): DiagnosticLogger {
  const enabled = options.enabled;
  const logDir = options.logDir
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
      sessionOpen: () => {},
      sessionClose: () => {},
      connectionRejected: () => {},
      requestRejected: () => {},
      projectCreated: () => {},
      projectEvicted: () => {},
      taskStarted: () => {},
      emit: () => {},
      batchCompleted: () => {},
      batchFailed: () => {},
      escalation: () => {},
      escalationUnavailable: () => {},
      fallback: () => {},
      fallbackUnavailable: () => {},
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
      const fd = openSync(nodePath.join(logDir, `mmagent-${today}.jsonl`), 'a', 0o600);
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
    startup: (version, extras) => {
      if (state.inert || state.startupEmitted) return;
      state.startupEmitted = true;
      writeLine({
        event: 'startup',
        ts: now().toISOString(),
        pid: process.pid,
        version,
        transport: extras?.transport ?? 'stdio',
      });
    },
    requestStart: ({ requestId, tool, sessionId, cwd }) => {
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
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    },
    requestComplete: ({ requestId, tool, durationMs, responseBytes, status, sessionId, cwd }) => {
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
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
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
      return nodePath.join(logDir, `mmagent-${formatUtcDate(now())}.jsonl`);
    },
    sessionOpen: ({ sessionId, cwd, remoteAddr }) => {
      if (state.inert) return;
      writeLine({
        event: 'session_open',
        ts: now().toISOString(),
        sessionId,
        cwd,
        ...(remoteAddr !== undefined ? { remoteAddr } : {}),
      });
    },
    sessionClose: ({ sessionId, cwd, reason, durationMs }) => {
      if (state.inert) return;
      writeLine({
        event: 'session_close',
        ts: now().toISOString(),
        sessionId,
        cwd,
        reason,
        durationMs,
      });
    },
    connectionRejected: ({ reason, httpStatus, cwd, remoteAddr }) => {
      if (state.inert) return;
      writeLine({
        event: 'connection_rejected',
        ts: now().toISOString(),
        reason,
        httpStatus,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(remoteAddr !== undefined ? { remoteAddr } : {}),
      });
    },
    requestRejected: ({ reason, httpStatus, sessionIdAttempted }) => {
      if (state.inert) return;
      writeLine({
        event: 'request_rejected',
        ts: now().toISOString(),
        reason,
        httpStatus,
        ...(sessionIdAttempted !== undefined ? { sessionIdAttempted } : {}),
      });
    },
    projectCreated: ({ cwd }) => {
      if (state.inert) return;
      writeLine({
        event: 'project_created',
        ts: now().toISOString(),
        cwd,
      });
    },
    projectEvicted: ({ cwd, idleMs }) => {
      if (state.inert) return;
      writeLine({
        event: 'project_evicted',
        ts: now().toISOString(),
        cwd,
        idleMs,
      });
    },
    taskStarted: ({ batchId, taskIndex, worker }) => {
      if (state.inert) return;
      writeLine({
        event: 'task_started',
        ts: now().toISOString(),
        batchId,
        taskIndex,
        ...(worker !== undefined ? { worker } : {}),
      });
    },
    emit: ({ event: name, batchId, taskIndex, ...rest }) => {
      if (state.inert) return;
      const out: Record<string, unknown> = {
        event: name,
        ts: now().toISOString(),
        batchId,
        taskIndex,
      };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) out[key] = value;
      }
      writeLine(out);
    },
    batchCompleted: ({ batchId, tool, durationMs, taskCount }) => {
      if (state.inert) return;
      writeLine({
        event: 'batch_completed',
        ts: now().toISOString(),
        batchId,
        tool,
        durationMs,
        taskCount,
      });
    },
    batchFailed: ({ batchId, tool, durationMs, errorCode, errorMessage }) => {
      if (state.inert) return;
      writeLine({
        event: 'batch_failed',
        ts: now().toISOString(),
        batchId,
        tool,
        durationMs,
        errorCode,
        errorMessage,
      });
    },
    escalation: (params) => {
      if (state.inert) return;
      writeLine({ event: 'escalation', ts: now().toISOString(), ...params });
    },
    escalationUnavailable: (params) => {
      if (state.inert) return;
      writeLine({ event: 'escalation_unavailable', ts: now().toISOString(), ...params });
    },
    fallback: (params) => {
      if (state.inert) return;
      writeLine({ event: 'fallback', ts: now().toISOString(), ...params });
    },
    fallbackUnavailable: (params) => {
      if (state.inert) return;
      writeLine({ event: 'fallback_unavailable', ts: now().toISOString(), ...params });
    },
  };
}
