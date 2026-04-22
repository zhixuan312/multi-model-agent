import type * as http from 'node:http';
import type { ProjectRegistry } from './project-registry.js';
import type { SessionRouter } from './session-router.js';
import type { MultiModelConfig, DiagnosticLogger } from '@zhixuan92/multi-model-agent-core';

export interface StatusHandlerOptions {
  registry: ProjectRegistry;
  router: SessionRouter;
  config: MultiModelConfig;
  logger: DiagnosticLogger;
  token: string;
}

export interface StatusHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
  updateBinding?(host: string, port: number): void;
}

export function buildStatusHandler(_options: StatusHandlerOptions): StatusHandler {
  const handler: StatusHandler = ((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: '0.0.0',
      transport: 'http',
      pid: process.pid,
      uptimeMs: 0,
      bind: '127.0.0.1:0',
      auth: { enabled: false },
      projects: [],
      activeRequests: [],
      recent: [],
    }));
  }) as StatusHandler;
  handler.updateBinding = (_host, _port) => { /* stub; filled in by Task 13 */ };
  return handler;
}
