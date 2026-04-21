import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnosticLogger } from '../../packages/core/src/diagnostics/disconnect-log.js';
import type { ShutdownCause } from '../../packages/core/src/diagnostics/disconnect-log.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-diagnostic-log-'));
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function withEnv(
  env: Partial<Record<'MCP_DIAGNOSTIC_LOG' | 'MCP_DIAGNOSTIC_LOG_DIR', string | undefined>>,
  fn: () => void | Promise<void>,
): Promise<void> | void {
  const previousLog = process.env.MCP_DIAGNOSTIC_LOG;
  const previousDir = process.env.MCP_DIAGNOSTIC_LOG_DIR;

  if (env.MCP_DIAGNOSTIC_LOG === undefined) delete process.env.MCP_DIAGNOSTIC_LOG;
  else process.env.MCP_DIAGNOSTIC_LOG = env.MCP_DIAGNOSTIC_LOG;

  if (env.MCP_DIAGNOSTIC_LOG_DIR === undefined) delete process.env.MCP_DIAGNOSTIC_LOG_DIR;
  else process.env.MCP_DIAGNOSTIC_LOG_DIR = env.MCP_DIAGNOSTIC_LOG_DIR;

  const restore = () => {
    if (previousLog === undefined) delete process.env.MCP_DIAGNOSTIC_LOG;
    else process.env.MCP_DIAGNOSTIC_LOG = previousLog;

    if (previousDir === undefined) delete process.env.MCP_DIAGNOSTIC_LOG_DIR;
    else process.env.MCP_DIAGNOSTIC_LOG_DIR = previousDir;
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function callAllLoggerMethods(): void {
  const logger = createDiagnosticLogger();
  logger.startup('2.7.4');
  logger.requestStart({ requestId: 'req-1', tool: 'delegate_tasks' });
  logger.requestComplete({
    requestId: 'req-1',
    tool: 'delegate_tasks',
    durationMs: 123,
    status: 'ok',
    responseBytes: 456,
  });
  logger.error('unhandledRejection', new Error('boom'));
  logger.shutdown('stdin_end');
}

describe('createDiagnosticLogger env gating', () => {
  it('with MCP_DIAGNOSTIC_LOG unset all methods no-op and no file is created', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: undefined, MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        callAllLoggerMethods();
        expect(fs.readdirSync(tmpDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('with MCP_DIAGNOSTIC_LOG empty all methods no-op and no file is created', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        callAllLoggerMethods();
        expect(fs.readdirSync(tmpDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['1', 'true', 'TRUE', 'Yes', 'on'])('truthy value %s enables logging', (value) => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: value, MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.startup('2.7.4');
        logger.shutdown('stdin_end');

        const files = fs.readdirSync(tmpDir);
        expect(files).toHaveLength(1);
        const events = readJsonl(path.join(tmpDir, files[0]));
        expect(events.map((e) => e.event)).toEqual(['startup', 'shutdown']);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['0', 'false', 'no', '', 'disable'])('falsy value %s disables logging', (value) => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: value, MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        callAllLoggerMethods();
        expect(fs.readdirSync(tmpDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger event schemas', () => {
  it('startup(version) writes the startup event schema', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.startup('2.7.4');

        const filePath = logger.expectedPath()!;
        const [entry] = readJsonl(filePath);
        expect(entry).toMatchObject({
          event: 'startup',
          pid: process.pid,
          version: '2.7.4',
        });
        expect(typeof entry.ts).toBe('string');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('requestStart writes the request_start event schema', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.requestStart({ requestId: 'req-123', tool: 'review_code' });

        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry).toMatchObject({
          event: 'request_start',
          requestId: 'req-123',
          tool: 'review_code',
        });
        expect(typeof entry.ts).toBe('string');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('requestComplete writes the request_complete event schema', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.requestComplete({
          requestId: 'req-456',
          tool: 'audit_document',
          durationMs: 789,
          status: 'error',
          responseBytes: 0,
        });

        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry).toMatchObject({
          event: 'request_complete',
          requestId: 'req-456',
          tool: 'audit_document',
          durationMs: 789,
          status: 'error',
          responseBytes: 0,
        });
        expect(typeof entry.ts).toBe('string');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('error(kind, Error) writes message and stack', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        const err = new Error('fatal boom');
        logger.error('uncaughtException', err);

        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry).toMatchObject({
          event: 'error',
          kind: 'uncaughtException',
          message: 'fatal boom',
        });
        expect(typeof entry.ts).toBe('string');
        expect(typeof entry.stack).toBe('string');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['plain string', 'boom string', undefined],
    ['object', { code: 'E_FAIL', nested: { value: 1 } }, undefined],
    ['null', null, undefined],
    ['undefined', undefined, undefined],
  ])('error(kind, %s) omits stack when absent', (_label, value, _unused) => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.error('unhandledRejection', value);

        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry.event).toBe('error');
        expect(entry.kind).toBe('unhandledRejection');
        expect(typeof entry.ts).toBe('string');
        expect(entry).not.toHaveProperty('stack');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shutdown(cause) writes the shutdown event schema', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.shutdown('stdin_end');

        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry).toMatchObject({
          event: 'shutdown',
          cause: 'stdin_end',
        });
        expect(typeof entry.ts).toBe('string');
        expect(typeof entry.uptimeMs).toBe('number');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger shutdown causes', () => {
  const causes: ShutdownCause[] = [
    'stdin_end',
    'SIGTERM',
    'SIGINT',
    'SIGPIPE',
    'SIGHUP',
    'SIGABRT',
    'event_loop_empty',
    'uncaughtException',
    'unhandledRejection',
    'stdout_epipe',
    'stdout_other_error',
  ];

  it.each(causes)('writes cause %s exactly', (cause) => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.shutdown(cause);
        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry.event).toBe('shutdown');
        expect(entry.cause).toBe(cause);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger idempotency', () => {
  it('startup() twice writes only one startup line', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.startup('2.7.4');
        logger.startup('2.7.4');
        const entries = readJsonl(logger.expectedPath()!);
        expect(entries).toHaveLength(1);
        expect(entries[0].event).toBe('startup');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shutdown() twice writes only one shutdown line', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.shutdown('stdin_end');
        logger.shutdown('stdin_end');
        const entries = readJsonl(logger.expectedPath()!);
        expect(entries).toHaveLength(1);
        expect(entries[0].event).toBe('shutdown');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger lastRequestInFlight', () => {
  it('omits lastRequestInFlight when there are no in-flight requests', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger();
        logger.shutdown('stdin_end');
        const [entry] = readJsonl(logger.expectedPath()!);
        expect(entry).not.toHaveProperty('lastRequestInFlight');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes the only in-flight request at shutdown', () => {
    const tmpDir = makeTempDir();
    const startedAt = new Date('2026-04-20T14:00:00.000Z');
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        let current = startedAt;
        const logger = createDiagnosticLogger({ now: () => current });
        logger.requestStart({ requestId: 'req-1', tool: 'delegate_tasks' });
        current = new Date('2026-04-20T14:00:05.000Z');
        logger.shutdown('stdin_end');

        const entries = readJsonl(logger.expectedPath()!);
        const shutdown = entries.at(-1)!;
        expect(shutdown.lastRequestInFlight).toEqual({
          requestId: 'req-1',
          tool: 'delegate_tasks',
          startedAt: '2026-04-20T14:00:00.000Z',
        });
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses the most recently started in-flight request when multiple are active', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const times = [
          new Date('2026-04-20T14:00:00.000Z'),
          new Date('2026-04-20T14:00:02.000Z'),
          new Date('2026-04-20T14:00:10.000Z'),
        ];
        let index = 0;
        const logger = createDiagnosticLogger({ now: () => times[index]! });
        logger.requestStart({ requestId: 'req-1', tool: 'audit_document' });
        index = 1;
        logger.requestStart({ requestId: 'req-2', tool: 'review_code' });
        index = 2;
        logger.shutdown('stdin_end');

        const shutdown = readJsonl(logger.expectedPath()!).at(-1)!;
        expect(shutdown.lastRequestInFlight).toEqual({
          requestId: 'req-2',
          tool: 'review_code',
          startedAt: '2026-04-20T14:00:02.000Z',
        });
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not include requests that completed before shutdown', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const times = [
          new Date('2026-04-20T14:00:00.000Z'),
          new Date('2026-04-20T14:00:01.000Z'),
          new Date('2026-04-20T14:00:02.000Z'),
        ];
        let index = 0;
        const logger = createDiagnosticLogger({ now: () => times[index]! });
        logger.requestStart({ requestId: 'req-1', tool: 'debug_task' });
        index = 1;
        logger.requestComplete({
          requestId: 'req-1',
          tool: 'debug_task',
          durationMs: 1000,
          status: 'ok',
          responseBytes: 42,
        });
        index = 2;
        logger.shutdown('stdin_end');

        const shutdown = readJsonl(logger.expectedPath()!).at(-1)!;
        expect(shutdown).not.toHaveProperty('lastRequestInFlight');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger duplicate requestId', () => {
  it('emits an error event when requestStart is called twice for the same requestId', () => {
    const tmpDir = makeTempDir();
    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const times = [
          new Date('2026-04-20T14:00:00.000Z'),
          new Date('2026-04-20T14:00:01.000Z'),
          new Date('2026-04-20T14:00:02.000Z'),
        ];
        let index = 0;
        const logger = createDiagnosticLogger({ now: () => times[index]! });
        logger.requestStart({ requestId: 'req-dup', tool: 'audit_document' });
        index = 1;
        logger.requestStart({ requestId: 'req-dup', tool: 'review_code' });
        index = 2;
        logger.shutdown('stdin_end');

        const entries = readJsonl(logger.expectedPath()!);
        const errorEntry = entries.find((e) => e.event === 'error');
        expect(errorEntry).toMatchObject({
          event: 'error',
          kind: 'duplicate_request_id',
        });
        expect(errorEntry!.message).toContain('req-dup');

        // The newer entry replaces the older one: lastRequestInFlight reports
        // the second tool, not the first.
        const shutdown = entries.at(-1)!;
        expect(shutdown.lastRequestInFlight).toMatchObject({
          requestId: 'req-dup',
          tool: 'review_code',
        });
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDiagnosticLogger degradation', () => {
  it('when log dir is unwritable it emits one stderr line and later calls no-op without throwing', () => {
    const tmpRoot = makeTempDir();
    const blockedPath = path.join(tmpRoot, 'existing-file');
    fs.writeFileSync(blockedPath, 'not a directory');
    const stderrLines: string[] = [];

    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: blockedPath }, () => {
        const logger = createDiagnosticLogger({
          stderrWrite: (data) => {
            stderrLines.push(data);
          },
        });

        expect(() => logger.startup('2.7.4')).not.toThrow();
        expect(() => logger.requestStart({ requestId: 'req-1', tool: 'delegate_tasks' })).not.toThrow();
        expect(() => logger.error('uncaughtException', new Error('boom'))).not.toThrow();
        expect(() => logger.shutdown('stdin_end')).not.toThrow();

        expect(stderrLines).toHaveLength(1);
        expect(stderrLines[0]).toContain('[diagnostic-log] disabled:');
        expect(fs.readFileSync(blockedPath, 'utf8')).toBe('not a directory');
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('after a write failure it disables once, emits one stderr line, and later writes no-op', () => {
    const tmpDir = makeTempDir();
    const stderrLines: string[] = [];
    const writes: string[] = [];
    let failOnce = true;

    try {
      withEnv({ MCP_DIAGNOSTIC_LOG: '1', MCP_DIAGNOSTIC_LOG_DIR: tmpDir }, () => {
        const logger = createDiagnosticLogger({
          stderrWrite: (data) => {
            stderrLines.push(data);
          },
          writeSync: (_fd, data) => {
            if (failOnce) {
              failOnce = false;
              throw new Error('simulated write failure');
            }
            writes.push(data);
          },
        });

        expect(() => logger.startup('2.7.4')).not.toThrow();
        expect(() => logger.requestStart({ requestId: 'req-1', tool: 'delegate_tasks' })).not.toThrow();
        expect(() => logger.shutdown('stdin_end')).not.toThrow();

        expect(stderrLines).toHaveLength(1);
        expect(stderrLines[0]).toContain('[diagnostic-log] disabled: simulated write failure');
        expect(writes).toEqual([]);
        expect(fs.readdirSync(tmpDir)).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, fs.readdirSync(tmpDir)[0]!), 'utf8')).toBe('');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
