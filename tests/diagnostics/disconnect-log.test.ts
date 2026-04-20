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
