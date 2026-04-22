import * as net from 'node:net';
import { startHttpDaemon, type DaemonHandle } from '../../packages/mcp/src/http/transport.js';
import { parseConfig } from '../../packages/core/src/config/schema.js';

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

export interface TestDaemonOptions {
  /** Override the http.bind value (default: 127.0.0.1) */
  bind?: string;
  /** Override the http.auth config */
  auth?: { enabled: boolean; tokenPath: string };
  /** Extra top-level config overrides (merged shallowly) */
  extras?: Record<string, unknown>;
}

export async function startTestDaemon(options?: TestDaemonOptions): Promise<DaemonHandle & { stop(): Promise<void> }> {
  const port = await getFreePort();
  const config = parseConfig({
    agents: {
      standard: { type: 'claude', model: 'test-model' },
      complex: { type: 'claude', model: 'test-model' },
    },
    transport: {
      mode: 'http',
      http: {
        bind: options?.bind ?? '127.0.0.1',
        port,
        projectIdleEvictionMs: 60_000,
        projectCap: 10,
        shutdownDrainMs: 1000,
        ...(options?.auth ? { auth: options.auth } : {}),
      },
    },
    ...options?.extras,
  });
  const handle = await startHttpDaemon(config, { testMode: true });
  return { ...handle, stop: handle.stop };
}
