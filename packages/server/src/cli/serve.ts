/**
 * serve.ts — starts the HTTP server and manages its signal lifecycle.
 *
 * This module owns the complete serve lifecycle: starting the HTTP server,
 * registering SIGTERM/SIGINT handlers, draining in-flight requests, and
 * cleanly exiting the process. The CLI entry point (cli/index.ts) delegates
 * to this module and does not manage signals directly.
 *
 * Usage (library):
 *   const handle = await startServe(config);
 *   // server is running on handle.port
 *   await handle.stop(); // graceful shutdown; no process.exit
 *
 * Usage (CLI):
 *   mmagent serve [--config <path>]
 *   // this module owns signal handling and process.exit
 */
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '../http/server.js';

/** A running server handle returned by startServe(). */
export interface ServeHandle {
  /** The port the server is listening on (useful when port=0 for ephemeral). */
  port: number;
  /**
   * Gracefully shut down the server.
   * Removes any registered SIGTERM/SIGINT handlers to prevent leaks.
   * After this resolves, the process is no longer listening and may exit safely.
   */
  stop(): Promise<void>;
}

/**
 * Shared signal-state used to deduplicate shutdown if two signals arrive
 * before stop() resolves.
 */
let stopInFlight = false;

// Stored so they can be removed when stop() is called programmatically
let onSigterm: (() => void) | undefined;
let onSigint: (() => void) | undefined;

/**
 * Start the HTTP server with the given config.
 *
 * Registers SIGTERM and SIGINT handlers that drain in-flight requests and
 * exit the process cleanly. If config includes `server.limits.shutdownDrainMs`,
 * the server will wait up to that duration for in-flight requests to finish.
 *
 * @param config  Full MultiModelConfig (includes agents.*, defaults, diagnostics,
 *                and server block).  startServer() inspects the agents.* field
 *                and enables real tool handlers when present.
 * @param exit    Process exit function — defaults to process.exit.
 *                Exposed so tests can suppress actual exits.
 */
export async function startServe(
  config: MultiModelConfig,
  exit: (code: number) => never = process.exit.bind(process),
): Promise<ServeHandle> {
  const running = await startServer({ server: config.server });

  const stderr = process.stderr.write.bind(process.stderr);

  const cleanupSignal = (sig: 'SIGTERM' | 'SIGINT') => {
    if (stopInFlight) return;
    stopInFlight = true;
    stderr(`[mmagent] received ${sig}, shutting down gracefully\u2026\n`);
    running.stop().then(() => exit(0)).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`[mmagent] shutdown failed: ${msg}\n`);
      exit(1);
    });
  };

  // Register handlers using named references so they can be removed correctly.
  // Using anonymous wrappers (e.g. `process.once('SIGTERM', () => fn(sig))`)
  // would make process.off(sig, fn) unable to find and remove the listener.
  onSigterm = () => cleanupSignal('SIGTERM');
  onSigint = () => cleanupSignal('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  // Print the actual bound address so operators see what the kernel assigned
  // (useful when port=0 selects an ephemeral port).
  const host = running.serverAddress ?? config.server.bind;
  stderr(`[mmagent] listening on ${host}:${running.port}\n`);

  return {
    port: running.port,
    stop: async () => {
      // Clean up signal listeners to prevent leaks when stop() is called
      // programmatically (i.e. not via a signal).
      if (onSigterm) process.off('SIGTERM', onSigterm);
      if (onSigint) process.off('SIGINT', onSigint);
      await running.stop();
    },
  };
}