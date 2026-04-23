import type { Server as HttpServer } from 'node:http';
import type { DiagnosticLogger } from '@zhixuan92/multi-model-agent-core';
import type { ProjectRegistry } from './project-registry.js';
import type { SessionRouter } from './session-router.js';

export interface HttpLifecycleOptions {
  shutdownDrainMs: number;
  noExit?: boolean; // for tests
}

let installed = false;
let cleanup: (() => void) | null = null;

export function installHttpLifecycleHandlers(
  logger: DiagnosticLogger,
  httpServer: HttpServer,
  registry: ProjectRegistry,
  router: SessionRouter,
  options: HttpLifecycleOptions,
): void {
  if (installed) return;
  installed = true;
  let shuttingDown = false;

  const hasInFlight = (): boolean => {
    for (const [, pc] of registry.entries()) {
      if (pc.activeRequests > 0) return true;
    }
    return false;
  };

  const drainAndExit = async (cause: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.stopEvictionTimer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    const deadline = Date.now() + options.shutdownDrainMs;
    while (Date.now() < deadline && hasInFlight()) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const timedOut = hasInFlight();
    await router.closeAll();
    registry.clear();
    logger.shutdown(timedOut ? 'SIGTERM_drain_timeout' : cause);
    if (!options.noExit) process.exit(0);
  };

  const onSigterm = () => { void drainAndExit('SIGTERM'); };
  const onSigint = () => { void drainAndExit('SIGINT'); };
  const onSighup = () => { /* no-op in HTTP mode */ };
  const onSigpipe = () => { /* no-op; per-connection SSE writes handled elsewhere */ };
  const onStdinEnd = () => { /* no-op in HTTP mode */ };
  const onStdoutError = () => { /* no-op at process level */ };
  const onUncaught = (err: Error) => {
    logger.error('uncaughtException', err);
    process.stderr.write(`[multi-model-agent] uncaughtException: ${err.stack ?? String(err)}\n`);
    registry.stopEvictionTimer();
    void router.closeAll().finally(() => {
      registry.clear();
      logger.shutdown('uncaughtException');
      if (!options.noExit) process.exit(1);
    });
  };
  const onUnhandled = (reason: unknown) => {
    logger.error('unhandledRejection', reason);
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`[multi-model-agent] unhandledRejection: ${stack}\n`);
    registry.stopEvictionTimer();
    void router.closeAll().finally(() => {
      registry.clear();
      logger.shutdown('unhandledRejection');
      if (!options.noExit) process.exit(1);
    });
  };

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.on('SIGHUP', onSighup);
  process.on('SIGPIPE', onSigpipe);
  process.stdin.on('end', onStdinEnd);
  process.stdout.on('error', onStdoutError);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);

  cleanup = () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    process.off('SIGHUP', onSighup);
    process.off('SIGPIPE', onSigpipe);
    process.stdin.off('end', onStdinEnd);
    process.stdout.off('error', onStdoutError);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    installed = false;
  };
}

/** Test-only. */
export function __resetHttpLifecycleHandlersForTests(): void {
  cleanup?.();
  cleanup = null;
  installed = false;
}
