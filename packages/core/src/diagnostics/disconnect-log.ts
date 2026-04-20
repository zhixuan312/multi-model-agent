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

  // Silence the lint warning for unused fs helpers until Task 3 wires them in.
  void openSync; void closeSync; void writeSync; void mkdirSync;

  return {
    request: () => { throw new Error('Task 3'); },
    notification: () => { throw new Error('Task 4'); },
    logError: () => { throw new Error('Task 5'); },
    shutdown: () => { throw new Error('Task 5'); },
    expectedPath: () => nodePath.join(logDir, `mcp-${formatUtcDate(now())}.jsonl`),
  };
}
