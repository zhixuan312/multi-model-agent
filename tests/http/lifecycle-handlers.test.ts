import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { installHttpLifecycleHandlers, __resetHttpLifecycleHandlersForTests } from '../../packages/mcp/src/http/lifecycle-handlers.js';

function makeLogger() {
  return {
    startup: vi.fn(),
    requestStart: vi.fn(),
    requestComplete: vi.fn(),
    error: vi.fn(),
    shutdown: vi.fn(),
    expectedPath: vi.fn(),
    sessionOpen: vi.fn(),
    sessionClose: vi.fn(),
    connectionRejected: vi.fn(),
    requestRejected: vi.fn(),
    projectCreated: vi.fn(),
    projectEvicted: vi.fn(),
  };
}

describe('installHttpLifecycleHandlers', () => {
  afterEach(() => { __resetHttpLifecycleHandlersForTests(); });

  it('SIGHUP is a no-op (no shutdown logged)', () => {
    const logger = makeLogger();
    const httpServer = new EventEmitter() as any;
    httpServer.close = vi.fn((cb) => cb?.());
    const router = { closeAll: vi.fn() } as any;
    const registry = { stopEvictionTimer: vi.fn(), clear: vi.fn() } as any;
    installHttpLifecycleHandlers(logger, httpServer, registry, router, { shutdownDrainMs: 1000, noExit: true });
    process.emit('SIGHUP');
    expect(logger.shutdown).not.toHaveBeenCalled();
  });

  it('stdin end does not trigger shutdown', () => {
    const logger = makeLogger();
    const httpServer = new EventEmitter() as any;
    httpServer.close = vi.fn((cb) => cb?.());
    const router = { closeAll: vi.fn() } as any;
    const registry = { stopEvictionTimer: vi.fn(), clear: vi.fn() } as any;
    installHttpLifecycleHandlers(logger, httpServer, registry, router, { shutdownDrainMs: 1000, noExit: true });
    process.stdin.emit('end');
    expect(logger.shutdown).not.toHaveBeenCalled();
  });

  it('SIGTERM triggers graceful drain with SIGTERM cause when requests are 0', async () => {
    const logger = makeLogger();
    const httpServer = new EventEmitter() as any;
    httpServer.close = vi.fn((cb) => cb?.());
    const router = { closeAll: vi.fn().mockResolvedValue(undefined) } as any;
    const registry = {
      stopEvictionTimer: vi.fn(),
      clear: vi.fn(),
      entries: function*() {},
    } as any;
    installHttpLifecycleHandlers(logger, httpServer, registry, router, { shutdownDrainMs: 100, noExit: true });
    process.emit('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    expect(logger.shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(router.closeAll).toHaveBeenCalled();
  });

  it('SIGTERM escalates to drain_timeout when activeRequests stays non-zero', async () => {
    const logger = makeLogger();
    const httpServer = new EventEmitter() as any;
    httpServer.close = vi.fn((cb) => cb?.());
    const router = { closeAll: vi.fn().mockResolvedValue(undefined) } as any;
    const registry = {
      stopEvictionTimer: vi.fn(),
      clear: vi.fn(),
      entries: function*() { yield ['/tmp', { activeRequests: 1 }]; },
    } as any;
    installHttpLifecycleHandlers(logger, httpServer, registry, router, { shutdownDrainMs: 50, noExit: true });
    process.emit('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    expect(logger.shutdown).toHaveBeenCalledWith('SIGTERM_drain_timeout');
  });
});
