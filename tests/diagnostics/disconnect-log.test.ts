import { createDiagnosticLogger } from '../../packages/core/src/diagnostics/disconnect-log.js';

function makeMocks() {
  const calls = {
    openSync: [] as Array<{ path: string; flags: string; mode: number }>,
    closeSync: [] as Array<{ fd: number }>,
    writeSync: [] as Array<{ fd: number; data: string }>,
    mkdirSync: [] as Array<{ path: string; options: unknown }>,
  };
  const openSync = (path: string, flags: string, mode: number) => {
    calls.openSync.push({ path, flags, mode });
    return 42;
  };
  const closeSync = (fd: number) => { calls.closeSync.push({ fd }); };
  const writeSync = (fd: number, data: string) => { calls.writeSync.push({ fd, data }); };
  const mkdirSync = (path: string, options: { recursive: true; mode: number }) => {
    calls.mkdirSync.push({ path, options });
  };
  return { calls, openSync, closeSync, writeSync, mkdirSync };
}

describe('DiagnosticLogger — construction and expectedPath', () => {
  it('construction opens no file, creates no directory, writes nothing', () => {
    const m = makeMocks();
    createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    expect(m.calls.openSync).toHaveLength(0);
    expect(m.calls.mkdirSync).toHaveLength(0);
    expect(m.calls.writeSync).toHaveLength(0);
    expect(m.calls.closeSync).toHaveLength(0);
  });

  it('expectedPath returns the UTC-date-derived file path without any fs call', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    expect(logger.expectedPath()).toBe('/tmp/fake-logs/mcp-2026-04-20.jsonl');
    expect(m.calls.openSync).toHaveLength(0);
    expect(m.calls.mkdirSync).toHaveLength(0);
  });

  it('expectedPath reflects the current UTC day when called across midnight', () => {
    const m = makeMocks();
    let current = new Date('2026-04-20T23:59:59.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => current,
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    expect(logger.expectedPath()).toBe('/tmp/fake-logs/mcp-2026-04-20.jsonl');
    current = new Date('2026-04-21T00:00:01.000Z');
    expect(logger.expectedPath()).toBe('/tmp/fake-logs/mcp-2026-04-21.jsonl');
  });

  it('defaults logDir to ~/.multi-model/logs when not provided', () => {
    const logger = createDiagnosticLogger({
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    });
    const path = logger.expectedPath();
    expect(path.endsWith('/.multi-model/logs/mcp-2026-04-20.jsonl')).toBe(true);
  });
});

describe('DiagnosticLogger — request events', () => {
  it('first request call materialises directory and opens the file lazily', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    logger.request({
      tool: 'delegate_tasks',
      requestId: 'req-1',
      progressToken: 'tok-1',
      durationMs: 100,
      responseBytes: 50,
      status: 'ok',
    });
    expect(m.calls.mkdirSync).toEqual([
      { path: '/tmp/fake-logs', options: { recursive: true, mode: 0o700 } },
    ]);
    expect(m.calls.openSync).toEqual([
      { path: '/tmp/fake-logs/mcp-2026-04-20.jsonl', flags: 'a', mode: 0o600 },
    ]);
    expect(m.calls.writeSync).toHaveLength(1);
    const line = m.calls.writeSync[0].data;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      event: 'request',
      tool: 'delegate_tasks',
      requestId: 'req-1',
      progressToken: 'tok-1',
      durationMs: 100,
      responseBytes: 50,
      status: 'ok',
    });
    expect(typeof parsed.ts).toBe('string');
    expect(typeof parsed.pid).toBe('number');
  });

  it('second request call reuses the open fd (no extra open)', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' });
    logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 2, responseBytes: 2, status: 'ok' });
    expect(m.calls.openSync).toHaveLength(1);
    expect(m.calls.writeSync).toHaveLength(2);
  });

  it('omits requestId and progressToken from JSON when undefined', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    logger.request({
      tool: 'audit_document',
      requestId: undefined,
      progressToken: undefined,
      durationMs: 10,
      responseBytes: 20,
      status: 'ok',
    });
    const parsed = JSON.parse(m.calls.writeSync[0].data);
    expect(parsed).not.toHaveProperty('requestId');
    expect(parsed).not.toHaveProperty('progressToken');
  });

  it('accepts numeric progressToken and preserves its type', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.request({
      tool: 't', requestId: undefined, progressToken: 1234,
      durationMs: 1, responseBytes: 1, status: 'ok',
    });
    expect(JSON.parse(m.calls.writeSync[0].data).progressToken).toBe(1234);
  });

  it('status:"error" requires responseBytes:0 — contract enforced by the caller, logger trusts the value', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.request({
      tool: 't', requestId: 'r1', progressToken: undefined,
      durationMs: 42, responseBytes: 0, status: 'error',
    });
    const parsed = JSON.parse(m.calls.writeSync[0].data);
    expect(parsed.status).toBe('error');
    expect(parsed.responseBytes).toBe(0);
  });
});

describe('DiagnosticLogger — notification batching', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not write on first notification — waits for the 5-second tick', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('hello', true);
    expect(m.calls.writeSync).toHaveLength(0);
  });

  it('flushes one notification_batch per 5-second window with attempted/succeeded counts', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('h1', true);
    logger.notification('h2', false);
    logger.notification('h3', true);
    nowMs += 5000;
    vi.advanceTimersByTime(5000);
    expect(m.calls.writeSync).toHaveLength(1);
    const parsed = JSON.parse(m.calls.writeSync[0].data);
    expect(parsed).toMatchObject({
      event: 'notification_batch',
      since: '2026-04-20T14:00:00.000Z',
      attempted: 3,
      succeeded: 2,
      lastHeadline: 'h3',
    });
  });

  it('`since` of the very first batch equals logger construction time', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    nowMs += 10000;
    logger.notification('first', true);
    nowMs += 5000;
    vi.advanceTimersByTime(5000);
    const parsed = JSON.parse(m.calls.writeSync[0].data);
    expect(parsed.since).toBe('2026-04-20T14:00:00.000Z');
  });

  it('sets `since` of the second batch to the ts of the first flush', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('a', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    const firstTs = JSON.parse(m.calls.writeSync[0].data).ts;
    logger.notification('b', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    const secondSince = JSON.parse(m.calls.writeSync[1].data).since;
    expect(secondSince).toBe(firstTs);
  });

  it('clears the interval after a fully idle window (no notifications in 5s)', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('a', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    expect(m.calls.writeSync).toHaveLength(1);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    expect(m.calls.writeSync).toHaveLength(1);
    nowMs += 10000; vi.advanceTimersByTime(10000);
    expect(m.calls.writeSync).toHaveLength(1);
  });

  it('restarts the interval when notification() is called after an idle clear', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('a', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    logger.notification('b', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    expect(m.calls.writeSync).toHaveLength(2);
    expect(JSON.parse(m.calls.writeSync[1].data).lastHeadline).toBe('b');
  });

  it('post-idle batch `since` equals the previous flush timestamp (contract: since = previous flush, across idle gaps)', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('a', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    const firstFlushTs = JSON.parse(m.calls.writeSync[0].data).ts;
    nowMs += 30000; vi.advanceTimersByTime(30000);
    logger.notification('b', true);
    nowMs += 5000; vi.advanceTimersByTime(5000);
    const secondSince = JSON.parse(m.calls.writeSync[1].data).since;
    expect(secondSince).toBe(firstFlushTs);
  });
});

describe('DiagnosticLogger — logError', () => {
  it('writes one error line per call with normalised Error', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    const err = new Error('boom');
    logger.logError('unhandledRejection', err);
    logger.logError('unhandledRejection', err);
    expect(m.calls.writeSync).toHaveLength(2);
    const p = JSON.parse(m.calls.writeSync[0].data);
    expect(p).toMatchObject({ event: 'error', cause: 'unhandledRejection', errorMessage: 'boom' });
    expect(typeof p.errorStack).toBe('string');
  });

  it('normalises string rejection reason', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.logError('unhandledRejection', 'naked string reject');
    const p = JSON.parse(m.calls.writeSync[0].data);
    expect(p.errorMessage).toBe('naked string reject');
    expect(p).not.toHaveProperty('errorStack');
  });

  it('normalises plain object rejection reason via JSON.stringify', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.logError('unhandledRejection', { code: 'X', detail: 42 });
    const p = JSON.parse(m.calls.writeSync[0].data);
    expect(p.errorMessage).toBe('{"code":"X","detail":42}');
    expect(p).not.toHaveProperty('errorStack');
  });

  it('handles null rejection reason', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.logError('unhandledRejection', null);
    const p = JSON.parse(m.calls.writeSync[0].data);
    expect(p.errorMessage).toBe('null');
    expect(p).not.toHaveProperty('errorStack');
  });

  it('handles circular references by replacing them with [Circular]', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    logger.logError('unhandledRejection', obj);
    const p = JSON.parse(m.calls.writeSync[0].data);
    expect(p.errorMessage).toContain('[Circular]');
    expect(p).not.toHaveProperty('errorStack');
  });
});

describe('DiagnosticLogger — shutdown', () => {
  it('writes a shutdown line with stdin_end cause and no error fields', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.shutdown('stdin_end');
    const p = JSON.parse(m.calls.writeSync.at(-1)!.data);
    expect(p).toMatchObject({ event: 'shutdown', cause: 'stdin_end' });
    expect(p).not.toHaveProperty('errorMessage');
    expect(p).not.toHaveProperty('errorStack');
  });

  it('includes lastRequest populated by the most recent request', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.request({ tool: 'review_code', requestId: 'r1', progressToken: 'p1', durationMs: 48213, responseBytes: 72184, status: 'ok' });
    nowMs += 664;
    logger.shutdown('stdout_epipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const p = JSON.parse(m.calls.writeSync.at(-1)!.data);
    expect(p.cause).toBe('stdout_epipe');
    expect(p.errorMessage).toBe('write EPIPE');
    expect(p.lastRequest).toMatchObject({
      tool: 'review_code',
      durationMs: 48213,
      responseBytes: 72184,
      msSinceCompletion: 664,
    });
  });

  it('notificationsSinceLastRequest resets after each request', () => {
    const m = makeMocks();
    let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date(nowMs),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.notification('h1', true);
    logger.notification('h2', false);
    logger.request({ tool: 't', requestId: 'r', progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' });
    logger.notification('h3', true);
    logger.shutdown('stdin_end');
    const shutdown = JSON.parse(m.calls.writeSync.at(-1)!.data);
    expect(shutdown.notificationsSinceLastRequest).toEqual({ attempted: 1, succeeded: 1 });
  });

  it('is idempotent — a second call is a no-op', () => {
    const m = makeMocks();
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
    });
    logger.shutdown('stdin_end');
    const countAfterFirst = m.calls.writeSync.length;
    logger.shutdown('uncaughtException', new Error('later'));
    expect(m.calls.writeSync).toHaveLength(countAfterFirst);
  });

  it('flushes a pending notification batch synchronously before writing shutdown', () => {
    vi.useFakeTimers();
    try {
      const m = makeMocks();
      let nowMs = Date.parse('2026-04-20T14:00:00.000Z');
      const logger = createDiagnosticLogger({
        logDir: '/tmp/fake-logs',
        now: () => new Date(nowMs),
        openSync: m.openSync, closeSync: m.closeSync, writeSync: m.writeSync, mkdirSync: m.mkdirSync,
      });
      logger.notification('pending', true);
      logger.shutdown('stdin_end');
      expect(m.calls.writeSync).toHaveLength(2);
      expect(JSON.parse(m.calls.writeSync[0].data).event).toBe('notification_batch');
      expect(JSON.parse(m.calls.writeSync[1].data).event).toBe('shutdown');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DiagnosticLogger — fs failure is swallowed', () => {
  it('disk-full on openSync marks the logger broken and subsequent calls are no-ops', () => {
    const m = makeMocks();
    const failingOpen = (_p: string, _f: string, _m: number): number => {
      throw new Error('ENOSPC');
    };
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: failingOpen,
      closeSync: m.closeSync,
      writeSync: m.writeSync,
      mkdirSync: m.mkdirSync,
    });
    expect(() => logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' })).not.toThrow();
    expect(m.calls.writeSync).toHaveLength(0);
    // shutdown always attempts (bypasses broken state), but openSync still fails — so still zero writes.
    expect(() => logger.shutdown('stdin_end')).not.toThrow();
    expect(m.calls.writeSync).toHaveLength(0);
  });

  it('EBADF on writeSync trips broken state on subsequent writes', () => {
    const m = makeMocks();
    let failNext = false;
    const flakyWrite = (fd: number, data: string) => {
      if (failNext) throw new Error('EBADF');
      m.calls.writeSync.push({ fd, data });
    };
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: flakyWrite, mkdirSync: m.mkdirSync,
    });
    logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' });
    expect(m.calls.writeSync).toHaveLength(1);
    failNext = true;
    expect(() => logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' })).not.toThrow();
    failNext = false;
    logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' });
    expect(m.calls.writeSync).toHaveLength(1);
  });

  it('shutdown still writes its line after a prior request write has broken the logger', () => {
    const m = makeMocks();
    let failNext = false;
    const flakyWrite = (fd: number, data: string) => {
      if (failNext) throw new Error('EBADF');
      m.calls.writeSync.push({ fd, data });
    };
    const logger = createDiagnosticLogger({
      logDir: '/tmp/fake-logs',
      now: () => new Date('2026-04-20T14:00:00.000Z'),
      openSync: m.openSync, closeSync: m.closeSync, writeSync: flakyWrite, mkdirSync: m.mkdirSync,
    });
    failNext = true;
    logger.request({ tool: 't', requestId: undefined, progressToken: undefined, durationMs: 1, responseBytes: 1, status: 'ok' });
    expect(m.calls.writeSync).toHaveLength(0);
    failNext = false;
    logger.shutdown('stdout_epipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(m.calls.writeSync).toHaveLength(1);
    const parsed = JSON.parse(m.calls.writeSync[0].data);
    expect(parsed.event).toBe('shutdown');
    expect(parsed.cause).toBe('stdout_epipe');
  });
});
