import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServerLog, JsonlWriter } from '../../packages/core/src/index.js';
import type { ShutdownCause } from '../../packages/core/src/index.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mma-http-server-log-'));
}

function makeWriter(tmpDir: string): JsonlWriter {
  return new JsonlWriter({ dir: tmpDir });
}

function readLines(dir: string): Array<Record<string, unknown>> {
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return [];
  const filePath = path.join(dir, entries[0]!);
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function callAllLoggerMethods(tmpDir: string, enabled: boolean): void {
  const logger = createHttpServerLog({ enabled, writer: makeWriter(tmpDir) });
  logger.startup('2.7.5');
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

describe('createHttpServerLog enablement', () => {
  it('enabled: false is a full no-op and no file is created', () => {
    const tmpDir = makeTempDir();
    try {
      callAllLoggerMethods(tmpDir, false);
      // The writer may create the directory but not write any content
      const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
      // With enabled=false, writeLine is never called, but the writer is not used
      expect(files.filter(f => f.endsWith('.jsonl'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enabled: true writes events', () => {
    const tmpDir = makeTempDir();
    try {
      callAllLoggerMethods(tmpDir, true);
      const events = readLines(tmpDir);
      expect(events.map((e) => e.event)).toEqual([
        'startup',
        'request_start',
        'request_complete',
        'error',
        'shutdown',
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createHttpServerLog event schemas', () => {
  it('startup(version) writes the startup event schema', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.startup('2.7.5');

      const [entry] = readLines(tmpDir);
      expect(entry).toMatchObject({
        event: 'startup',
        pid: process.pid,
        version: '2.7.5',
      });
      expect(typeof entry.ts).toBe('string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('requestStart writes the request_start event schema', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.requestStart({ requestId: 'req-123', tool: 'review_code' });

      const [entry] = readLines(tmpDir);
      expect(entry).toMatchObject({
        event: 'request_start',
        requestId: 'req-123',
        tool: 'review_code',
      });
      expect(typeof entry.ts).toBe('string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('requestComplete writes the request_complete event schema', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.requestComplete({
        requestId: 'req-456',
        tool: 'audit_document',
        durationMs: 789,
        status: 'error',
        responseBytes: 0,
      });

      const [entry] = readLines(tmpDir);
      expect(entry).toMatchObject({
        event: 'request_complete',
        requestId: 'req-456',
        tool: 'audit_document',
        durationMs: 789,
        status: 'error',
        responseBytes: 0,
      });
      expect(typeof entry.ts).toBe('string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('error(kind, Error) writes message and stack', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      const err = new Error('fatal boom');
      logger.error('uncaughtException', err);

      const [entry] = readLines(tmpDir);
      expect(entry).toMatchObject({
        event: 'error',
        kind: 'uncaughtException',
        message: 'fatal boom',
      });
      expect(typeof entry.ts).toBe('string');
      expect(typeof entry.stack).toBe('string');
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
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.error('unhandledRejection', value);

      const [entry] = readLines(tmpDir);
      expect(entry.event).toBe('error');
      expect(entry.kind).toBe('unhandledRejection');
      expect(typeof entry.ts).toBe('string');
      expect(entry).not.toHaveProperty('stack');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shutdown(cause) writes the shutdown event schema', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.shutdown('stdin_end');

      const [entry] = readLines(tmpDir);
      expect(entry).toMatchObject({
        event: 'shutdown',
        cause: 'stdin_end',
      });
      expect(typeof entry.ts).toBe('string');
      expect(typeof entry.uptimeMs).toBe('number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createHttpServerLog shutdown causes', () => {
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
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.shutdown(cause);
      const [entry] = readLines(tmpDir);
      expect(entry.event).toBe('shutdown');
      expect(entry.cause).toBe(cause);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createHttpServerLog idempotency', () => {
  it('startup() twice writes only one startup line', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.startup('2.7.5');
      logger.startup('2.7.5');
      const entries = readLines(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.event).toBe('startup');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shutdown() twice writes only one shutdown line', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.shutdown('stdin_end');
      logger.shutdown('stdin_end');
      const entries = readLines(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.event).toBe('shutdown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createHttpServerLog lastRequestInFlight', () => {
  it('omits lastRequestInFlight when there are no in-flight requests', () => {
    const tmpDir = makeTempDir();
    try {
      const writer = makeWriter(tmpDir);
      const logger = createHttpServerLog({ enabled: true, writer });
      logger.shutdown('stdin_end');
      const [entry] = readLines(tmpDir);
      expect(entry).not.toHaveProperty('lastRequestInFlight');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes the only in-flight request at shutdown', () => {
    const tmpDir = makeTempDir();
    const startedAt = new Date('2026-04-20T14:00:00.000Z');
    try {
      let current = startedAt;
      const writer = new JsonlWriter({ dir: tmpDir, now: () => current });
      const logger = createHttpServerLog({ enabled: true, writer, now: () => current });
      logger.requestStart({ requestId: 'req-1', tool: 'delegate_tasks' });
      current = new Date('2026-04-20T14:00:05.000Z');
      logger.shutdown('stdin_end');

      const entries = readLines(tmpDir);
      const shutdown = entries.at(-1)!;
      expect(shutdown.lastRequestInFlight).toEqual({
        requestId: 'req-1',
        tool: 'delegate_tasks',
        startedAt: '2026-04-20T14:00:00.000Z',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses the most recently started in-flight request when multiple are active', () => {
    const tmpDir = makeTempDir();
    try {
      const times = [
        new Date('2026-04-20T14:00:00.000Z'),
        new Date('2026-04-20T14:00:02.000Z'),
        new Date('2026-04-20T14:00:10.000Z'),
      ];
      let index = 0;
      const writer = new JsonlWriter({ dir: tmpDir, now: () => times[index]! });
      const logger = createHttpServerLog({ enabled: true, writer, now: () => times[index]! });
      logger.requestStart({ requestId: 'req-1', tool: 'audit_document' });
      index = 1;
      logger.requestStart({ requestId: 'req-2', tool: 'review_code' });
      index = 2;
      logger.shutdown('stdin_end');

      const shutdown = readLines(tmpDir).at(-1)!;
      expect(shutdown.lastRequestInFlight).toEqual({
        requestId: 'req-2',
        tool: 'review_code',
        startedAt: '2026-04-20T14:00:02.000Z',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not include requests that completed before shutdown', () => {
    const tmpDir = makeTempDir();
    try {
      const times = [
        new Date('2026-04-20T14:00:00.000Z'),
        new Date('2026-04-20T14:00:01.000Z'),
        new Date('2026-04-20T14:00:02.000Z'),
      ];
      let index = 0;
      const writer = new JsonlWriter({ dir: tmpDir, now: () => times[index]! });
      const logger = createHttpServerLog({ enabled: true, writer, now: () => times[index]! });
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

      const shutdown = readLines(tmpDir).at(-1)!;
      expect(shutdown).not.toHaveProperty('lastRequestInFlight');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createHttpServerLog duplicate requestId', () => {
  it('emits an error event when requestStart is called twice for the same requestId', () => {
    const tmpDir = makeTempDir();
    try {
      const times = [
        new Date('2026-04-20T14:00:00.000Z'),
        new Date('2026-04-20T14:00:01.000Z'),
        new Date('2026-04-20T14:00:02.000Z'),
      ];
      let index = 0;
      const writer = new JsonlWriter({ dir: tmpDir, now: () => times[index]! });
      const logger = createHttpServerLog({ enabled: true, writer, now: () => times[index]! });
      logger.requestStart({ requestId: 'req-dup', tool: 'audit_document' });
      index = 1;
      logger.requestStart({ requestId: 'req-dup', tool: 'review_code' });
      index = 2;
      logger.shutdown('stdin_end');

      const entries = readLines(tmpDir);
      const errorEntry = entries.find((e) => e.event === 'error');
      expect(errorEntry).toMatchObject({
        event: 'error',
        kind: 'duplicate_request_id',
      });
      expect(errorEntry!.message).toContain('req-dup');

      const shutdown = entries.at(-1)!;
      expect(shutdown.lastRequestInFlight).toMatchObject({
        requestId: 'req-dup',
        tool: 'review_code',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
