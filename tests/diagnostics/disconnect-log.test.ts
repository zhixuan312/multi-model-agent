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
