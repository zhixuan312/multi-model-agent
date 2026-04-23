import type * as http from 'node:http';
import type { ProjectRegistry } from './project-registry.js';
import type { SessionRouter } from './session-router.js';
import type { MultiModelConfig, DiagnosticLogger } from '@zhixuan92/multi-model-agent-core';
import { SERVER_VERSION } from '../cli.js';
import { isLoopbackAddress } from './loopback.js';
import { validateAuthHeader } from './auth.js';

export interface StatusHandlerOptions {
  registry: ProjectRegistry;
  router: SessionRouter;
  config: MultiModelConfig;
  logger: DiagnosticLogger;
  token: string;
}

export interface StatusHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
  updateBinding(host: string, port: number): void;
  trackRequestStart(sessionId: string, cwd: string, tool: string): string;
  trackRequestEnd(reqTrackId: string, status: 'ok' | 'error', durationMs: number): void;
  trackHeadline(reqTrackId: string, headline: string): void;
}

export function buildStatusHandler(options: StatusHandlerOptions): StatusHandler {
  const startedAtMs = Date.now();
  let boundHost = options.config.transport.http.bind;
  let boundPort = options.config.transport.http.port;

  interface ActiveRequest {
    sessionId: string;
    cwd: string;
    tool: string;
    startedAt: number;
    lastHeadline?: string;
  }
  const active = new Map<string, ActiveRequest>();
  interface RecentRequest {
    sessionId: string;
    cwd: string;
    tool: string;
    durationMs: number;
    status: 'ok' | 'error';
  }
  const recent: RecentRequest[] = [];
  const RECENT_MAX = 100;

  const handler = ((req: http.IncomingMessage, res: http.ServerResponse) => {
    const peer = req.socket.remoteAddress;
    if (!isLoopbackAddress(peer)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', message: '/status is loopback-only' }));
      return;
    }
    if (options.config.transport.http.auth.enabled) {
      const auth = validateAuthHeader(
        Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization,
        options.token,
      );
      if (!auth.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    const projects: unknown[] = [];
    for (const [cwd, pc] of options.registry.entries()) {
      projects.push({
        cwd,
        createdAt: new Date(pc.createdAt).toISOString(),
        lastSeenAt: new Date(pc.lastSeenAt).toISOString(),
        activeSessions: pc.activeSessions.size,
        batchCacheSize: pc.batchCache.size,
        contextBlocksSize: pc.contextBlocks.size,
        clarificationsSize: pc.clarifications.size,
      });
    }

    const displayHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
    const body = {
      version: SERVER_VERSION,
      pid: process.pid,
      transport: 'http' as const,
      bind: `${displayHost}:${boundPort}`,
      uptimeMs: Date.now() - startedAtMs,
      auth: { enabled: options.config.transport.http.auth.enabled },
      projects,
      activeRequests: Array.from(active.values()).map(r => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        tool: r.tool,
        startedAt: new Date(r.startedAt).toISOString(),
        lastHeadline: r.lastHeadline,
      })),
      recent: recent.slice(-10),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }) as StatusHandler;

  handler.updateBinding = (host: string, port: number) => {
    boundHost = host;
    boundPort = port;
  };

  handler.trackRequestStart = (sessionId, cwd, tool) => {
    const id = `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    active.set(id, { sessionId, cwd, tool, startedAt: Date.now() });
    return id;
  };

  handler.trackRequestEnd = (id, status, durationMs) => {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    recent.push({ sessionId: entry.sessionId, cwd: entry.cwd, tool: entry.tool, status, durationMs });
    while (recent.length > RECENT_MAX) recent.shift();
  };

  handler.trackHeadline = (id, headline) => {
    const entry = active.get(id);
    if (!entry) return;
    entry.lastHeadline = headline;
  };

  return handler;
}
