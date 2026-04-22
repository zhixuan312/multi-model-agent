import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createDiagnosticLogger,
  type DiagnosticLogger,
  type MultiModelConfig,
} from '@zhixuan92/multi-model-agent-core';
import { buildMcpServer, SERVER_VERSION } from '../cli.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionRouter, type SessionEntry } from './session-router.js';
import { installHttpLifecycleHandlers } from './lifecycle-handlers.js';
import { isLoopbackAddress } from './loopback.js';
import { loadToken, validateAuthHeader } from './auth.js';
import { buildStatusHandler } from './status-endpoint.js';

const RESERVATION_TIMEOUT_MS = 5000;

export interface DaemonHandle {
  url: string;
  logger: DiagnosticLogger;
  registry: ProjectRegistry;
  router: SessionRouter;
  stop: () => Promise<void>;
}

export async function startHttpDaemon(
  config: MultiModelConfig,
  options?: { testMode?: boolean },
): Promise<DaemonHandle> {
  const transportConfig = config.transport;
  if (transportConfig.mode !== 'http') {
    throw new Error(`startHttpDaemon called with transport.mode=${transportConfig.mode}`);
  }
  const httpConfig = transportConfig.http;

  if (!isLoopbackAddress(httpConfig.bind) && !httpConfig.auth.enabled) {
    throw new Error(
      `transport.http.bind='${httpConfig.bind}' is not loopback; transport.http.auth.enabled must be true to bind non-loopback`,
    );
  }

  const enabled = config.diagnostics?.log ?? false;
  const logger = createDiagnosticLogger({ enabled, logDir: config.diagnostics?.logDir });
  logger.startup(SERVER_VERSION, { transport: 'http' });

  const token = httpConfig.auth.enabled ? loadToken(httpConfig.auth.tokenPath) : '';

  const registry = new ProjectRegistry({
    cap: httpConfig.projectCap,
    idleEvictionMs: httpConfig.projectIdleEvictionMs,
    evictionIntervalMs: 5 * 60 * 1000,
    onProjectCreated: (cwd) => logger.projectCreated({ cwd }),
    onProjectEvicted: (cwd, idleMs) => logger.projectEvicted({ cwd, idleMs }),
  });
  registry.startEvictionTimer();

  const router = new SessionRouter();
  const statusHandler = buildStatusHandler({ registry, router, config, logger, token });

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> => {
    const u = new URL(req.url ?? '/', 'http://localhost');

    if (httpConfig.auth.enabled) {
      if (u.searchParams.has('token')) {
        logger.connectionRejected({ reason: 'unauthorized', httpStatus: 401, cwd: u.searchParams.get('cwd') ?? undefined });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'token must be sent as Authorization header, not query param' }));
        return;
      }
      const auth = validateAuthHeader(
        Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization,
        token,
      );
      if (!auth.ok) {
        logger.connectionRejected({ reason: 'unauthorized', httpStatus: 401 });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const existingSessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let parsedBody: unknown;
    try {
      parsedBody = body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    if (existingSessionId) {
      const entry = router.get(existingSessionId);
      if (!entry) {
        logger.requestRejected({ reason: 'unknown_session', httpStatus: 404, sessionIdAttempted: existingSessionId });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_session' }));
        return;
      }
      entry.projectContext.lastSeenAt = Date.now();
      try {
        await entry.transport.handleRequest(req, res, parsedBody);
      } catch (err) {
        logger.error('transport_handle_request', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
      return;
    }

    const isInitialize = parsedBody !== null
      && typeof parsedBody === 'object'
      && (parsedBody as { method?: unknown }).method === 'initialize';
    if (!isInitialize) {
      logger.requestRejected({ reason: 'missing_session_or_initialize', httpStatus: 400 });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_session_or_initialize', message: 'first request must be JSON-RPC initialize; follow-up requests must carry Mcp-Session-Id' }));
      return;
    }

    const cwdParam = u.searchParams.get('cwd') ?? undefined;
    const reserveResult = registry.reserveProject(cwdParam ?? '');
    if (!reserveResult.ok) {
      const status = reserveResult.error === 'project_cap' ? 503 : 400;
      logger.connectionRejected({ reason: reserveResult.error, httpStatus: status, cwd: cwdParam });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reserveResult.error, message: reserveResult.message }));
      return;
    }
    const { projectContext } = reserveResult;
    const canonicalCwd = projectContext.cwd;

    const reservationTimeout = setTimeout(() => {
      registry.cancelReservation(canonicalCwd);
    }, RESERVATION_TIMEOUT_MS);
    reservationTimeout.unref?.();

    let sessionIdCaptured: string | undefined;
    const mcpServer = buildMcpServer(config, logger, { projectContext });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        clearTimeout(reservationTimeout);
        sessionIdCaptured = sessionId;
        registry.attachSession(canonicalCwd, sessionId);
        const openedAt = Date.now();
        const entry: SessionEntry = { transport, server: mcpServer, projectContext, openedAt };
        router.set(sessionId, entry);
        logger.sessionOpen({ sessionId, cwd: canonicalCwd, remoteAddr: req.socket.remoteAddress });
      },
    });

    transport.onclose = () => {
      if (!sessionIdCaptured) return;
      const entry = router.get(sessionIdCaptured);
      if (!entry) return;
      const durationMs = Date.now() - entry.openedAt;
      registry.detachSession(canonicalCwd, sessionIdCaptured);
      logger.sessionClose({ sessionId: sessionIdCaptured, cwd: canonicalCwd, reason: 'client_closed', durationMs });
      router.delete(sessionIdCaptured);
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      clearTimeout(reservationTimeout);
      registry.cancelReservation(canonicalCwd);
      logger.error('initialize_failed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'initialize_failed' }));
      }
    }
  };

  const httpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname === '/status') {
        statusHandler(req, res);
        return;
      }
      if (u.pathname === '/') {
        void handleMcp(req, res, body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpConfig.port, httpConfig.bind, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : httpConfig.port;
  const boundHost = typeof addr === 'object' && addr !== null ? addr.address : httpConfig.bind;
  const urlHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  const url = `http://${urlHost}:${boundPort}`;

  statusHandler.updateBinding?.(boundHost, boundPort);

  if (!options?.testMode) {
    process.stderr.write(
      `[multi-model-agent] HTTP: ${url}  (auth: ${httpConfig.auth.enabled ? 'on' : 'off'})\n`,
    );
    const logPath = logger.expectedPath();
    if (logPath) process.stderr.write(`[multi-model-agent] diagnostic log: ${logPath}\n`);
    installHttpLifecycleHandlers(logger, httpServer, registry, router, {
      shutdownDrainMs: httpConfig.shutdownDrainMs,
    });
  }

  const stop = async (): Promise<void> => {
    registry.stopEvictionTimer();
    await router.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    registry.clear();
  };

  return { url, logger, registry, router, stop };
}
