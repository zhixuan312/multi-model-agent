import { describe, it, expect } from 'vitest';
import { createDiagnosticLogger } from '../../packages/core/src/diagnostics/disconnect-log.js';

function captureLines(): { logger: ReturnType<typeof createDiagnosticLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    enabled: true,
    logDir: '/tmp/test-http-events',
    openSync: () => 1,
    closeSync: () => {},
    writeSync: (_fd: number, data: string) => { lines.push(data.trimEnd()); },
    mkdirSync: () => {},
    stderrWrite: () => {},
  });
  return { logger, lines };
}

describe('HTTP diagnostic events', () => {
  it('startup event includes transport field', () => {
    const { logger, lines } = captureLines();
    logger.startup('2.8.0', { transport: 'http' });
    const evt = JSON.parse(lines[0]);
    expect(evt.event).toBe('startup');
    expect(evt.transport).toBe('http');
    expect(evt.version).toBe('2.8.0');
  });

  it('startup event defaults transport to stdio when not provided', () => {
    const { logger, lines } = captureLines();
    logger.startup('2.8.0');
    const evt = JSON.parse(lines[0]);
    expect(evt.transport).toBe('stdio');
  });

  it('sessionOpen writes session_open event', () => {
    const { logger, lines } = captureLines();
    logger.sessionOpen({ sessionId: 's1', cwd: '/tmp/p' });
    const evt = JSON.parse(lines[0]);
    expect(evt.event).toBe('session_open');
    expect(evt.sessionId).toBe('s1');
    expect(evt.cwd).toBe('/tmp/p');
  });

  it('sessionClose writes session_close event with reason + durationMs', () => {
    const { logger, lines } = captureLines();
    logger.sessionClose({ sessionId: 's1', cwd: '/tmp/p', reason: 'client_closed', durationMs: 1234 });
    const evt = JSON.parse(lines[0]);
    expect(evt.event).toBe('session_close');
    expect(evt.reason).toBe('client_closed');
    expect(evt.durationMs).toBe(1234);
  });

  it('connectionRejected writes connection_rejected event without sessionId', () => {
    const { logger, lines } = captureLines();
    logger.connectionRejected({ reason: 'invalid_cwd', httpStatus: 400 });
    const evt = JSON.parse(lines[0]);
    expect(evt.event).toBe('connection_rejected');
    expect(evt.reason).toBe('invalid_cwd');
    expect(evt.httpStatus).toBe(400);
    expect(evt.sessionId).toBeUndefined();
  });

  it('projectCreated and projectEvicted events', () => {
    const { logger, lines } = captureLines();
    logger.projectCreated({ cwd: '/tmp/p' });
    logger.projectEvicted({ cwd: '/tmp/p', idleMs: 3_600_000 });
    expect(JSON.parse(lines[0]).event).toBe('project_created');
    expect(JSON.parse(lines[1]).event).toBe('project_evicted');
    expect(JSON.parse(lines[1]).idleMs).toBe(3_600_000);
  });

  it('requestStart accepts optional sessionId + cwd', () => {
    const { logger, lines } = captureLines();
    logger.requestStart({ requestId: 'r1', tool: 'delegate_tasks', sessionId: 's1', cwd: '/tmp/p' });
    const evt = JSON.parse(lines[0]);
    expect(evt.sessionId).toBe('s1');
    expect(evt.cwd).toBe('/tmp/p');
  });

  it('requestStart omits sessionId + cwd when not provided (stdio path)', () => {
    const { logger, lines } = captureLines();
    logger.requestStart({ requestId: 'r1', tool: 'delegate_tasks' });
    const evt = JSON.parse(lines[0]);
    expect(evt.sessionId).toBeUndefined();
    expect(evt.cwd).toBeUndefined();
  });
});
