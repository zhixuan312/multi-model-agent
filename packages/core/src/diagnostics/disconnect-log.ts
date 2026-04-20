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

export function createDiagnosticLogger(
  _options?: CreateDiagnosticLoggerOptions,
): DiagnosticLogger {
  throw new Error('not implemented — Task 2+ fills this in');
}
