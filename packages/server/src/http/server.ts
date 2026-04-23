import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig, BatchRegistry } from '@zhixuan92/multi-model-agent-core';
import { Router } from './router.js';
import { sendError, sendJson } from './errors.js';
import { readBody } from './middleware/body-reader.js';
import { loadToken, validateAuthHeader } from './auth.js';
import { validateCwd } from './cwd-validator.js';
import { isLoopbackAddress } from './loopback.js';
import type { RequestContext } from './types.js';
import type { ProjectRegistry } from './project-registry.js';

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
  /** Shared BatchRegistry — exposed for testing and introspection handlers. */
  batchRegistry: BatchRegistry;
  /** Shared ProjectRegistry — exposed for testing and introspection handlers. */
  projectRegistry: ProjectRegistry;
}

/** Routes where the loopback guard is enforced. */
const LOOPBACK_ONLY_PATHS = new Set(['/health', '/status']);

/** Routes that do NOT require bearer auth. */
const AUTH_EXEMPT_PATHS = new Set(['/health']);

/** Routes that require a `cwd` query parameter (validated by cwd-validator middleware). */
const CWD_REQUIRED_PATHS = new Set([
  '/delegate', '/audit', '/review', '/verify', '/debug', '/execute-plan', '/retry',
  '/context-blocks',
]);

/**
 * Registers tool handlers (POST /delegate, /audit, /review, /verify, /debug, /execute-plan, /retry).
 * Imported dynamically to avoid circular-dependency issues and to keep startServer lean.
 */
async function registerToolHandlers(
  router: Router,
  config: ServerConfig,
  batchRegistry: BatchRegistry,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildDelegateHandler } = await import('./handlers/tools/delegate.js');
  const { buildAuditHandler } = await import('./handlers/tools/audit.js');
  const { buildReviewHandler } = await import('./handlers/tools/review.js');
  const { buildVerifyHandler } = await import('./handlers/tools/verify.js');
  const { buildDebugHandler } = await import('./handlers/tools/debug.js');
  const { buildExecutePlanHandler } = await import('./handlers/tools/execute-plan.js');
  const { buildRetryHandler } = await import('./handlers/tools/retry.js');
  const { createDiagnosticLogger } = await import('@zhixuan92/multi-model-agent-core');

  const logger = createDiagnosticLogger({ enabled: false });

  // For tool handlers, we need MultiModelConfig which is part of ServerConfig only
  // when the full mmagent.config.json is loaded. In test/minimal configs that only
  // have `server:`, we create a stub config. Real CLI startup will load full config.
  // Cast through unknown to avoid type gymnastics here; validation happens in schema.
  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
    : undefined;

  if (!multiModelConfig) {
    // Server started with server-only config (e.g. tests): register stubs that return 503
    for (const [method, path] of [
      ['POST', '/delegate'], ['POST', '/audit'], ['POST', '/review'],
      ['POST', '/verify'], ['POST', '/debug'], ['POST', '/execute-plan'], ['POST', '/retry'],
    ] as [string, string][]) {
      router.register(method, path, (_req, res, _params, _ctx) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
      });
    }
    return;
  }

  const deps: import('./handler-deps.js').HandlerDeps = {
    config: multiModelConfig,
    logger,
    projectRegistry,
    batchRegistry,
  };

  router.register('POST', '/delegate', buildDelegateHandler(deps));
  router.register('POST', '/audit', buildAuditHandler(deps));
  router.register('POST', '/review', buildReviewHandler(deps));
  router.register('POST', '/verify', buildVerifyHandler(deps));
  router.register('POST', '/debug', buildDebugHandler(deps));
  router.register('POST', '/execute-plan', buildExecutePlanHandler(deps));
  router.register('POST', '/retry', buildRetryHandler(deps));
}

/**
 * Registers control handlers (GET /batch/:batchId, POST/DELETE /context-blocks,
 * POST /clarifications/confirm).
 */
async function registerControlHandlers(
  router: Router,
  config: ServerConfig,
  batchRegistry: BatchRegistry,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildBatchHandler } = await import('./handlers/control/batch.js');
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');
  const { buildClarificationsHandler } = await import('./handlers/control/clarifications.js');

  router.register('GET', '/batch/:batchId', buildBatchHandler({ batchRegistry }));
  router.register('POST', '/context-blocks', buildCreateContextBlockHandler({ projectRegistry, config }));
  router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  router.register('POST', '/clarifications/confirm', buildClarificationsHandler({ batchRegistry }));
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const token = loadToken(config.server.auth.tokenFile);

  const router = new Router();

  // ── Create shared registries ───────────────────────────────────────────────
  const { BatchRegistry } = await import('@zhixuan92/multi-model-agent-core');
  const { ProjectRegistry } = await import('./project-registry.js');

  const batchRegistry = new BatchRegistry({
    batchTtlMs: config.server.limits.batchTtlMs,
    clarificationTimeoutMs: config.server.limits.clarificationTimeoutMs,
  });

  const projectRegistry = new ProjectRegistry({
    cap: config.server.limits.projectCap,
    idleEvictionMs: config.server.limits.idleProjectTimeoutMs,
    evictionIntervalMs: Math.min(config.server.limits.idleProjectTimeoutMs, 60_000),
  });

  // GET /health — lightweight liveness probe
  router.register('GET', '/health', (_req, res, _params, _ctx) => {
    sendJson(res, 200, { ok: true });
  });

  // Register tool handlers (Phase 6)
  await registerToolHandlers(router, config, batchRegistry, projectRegistry);

  // Register control handlers (Phase 7)
  await registerControlHandlers(router, config, batchRegistry, projectRegistry);

  const server = createServer((req, res) => {
    void handleRequest(router, token, req, res, config);
  });

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.bind, resolve);
  });

  const addr = server.address();
  const port = (addr as { port: number }).port;

  return {
    port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    batchRegistry,
    projectRegistry,
  };
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handleRequest(
  router: Router,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  // ── Step 1: Body size cap (for methods that carry a body) ──────────────────
  let rawBody: Buffer | undefined;
  if (BODY_METHODS.has(method)) {
    const result = await readBody(req, cfg.server.limits.maxBodyBytes);
    if (!result.ok) {
      // Send 413 then close; include Connection: close so the client knows
      res.writeHead(413, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(
        JSON.stringify({ error: { code: 'payload_too_large', message: `Request body exceeds the ${cfg.server.limits.maxBodyBytes}-byte limit` } }),
        () => { req.socket?.destroy(); },
      );
      return;
    }
    rawBody = result.body;
  }

  // ── Step 2: Route match (404 not_found / 405 method_not_allowed) ──────────
  const match = router.match(method, rawUrl);
  if (!match) {
    const allowed = router.methodsFor(rawUrl);
    if (allowed.length > 0) {
      sendError(res, 405, 'method_not_allowed', `Method ${method} not allowed`, { allowed });
    } else {
      sendError(res, 404, 'not_found', `Unknown path ${rawUrl.split('?')[0]}`);
    }
    return;
  }

  // ── Step 3: Loopback guard for /health and /status ────────────────────────
  const pathname = rawUrl.split('?')[0];
  if (LOOPBACK_ONLY_PATHS.has(pathname)) {
    const remoteAddr = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      sendError(res, 403, 'loopback_only', 'This endpoint is only accessible from the loopback interface');
      return;
    }
  }

  // ── Step 4: Auth (bearer token) — skip for /health ───────────────────────
  if (!AUTH_EXEMPT_PATHS.has(pathname)) {
    const header = req.headers['authorization'];
    const authResult = validateAuthHeader(header, token);
    if (!authResult.ok) {
      sendError(res, 401, 'unauthorized', 'Valid Bearer token required');
      return;
    }
  }

  // ── Step 5: JSON parse → ctx.body ────────────────────────────────────────
  let parsedBody: unknown;
  if (rawBody !== undefined && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }
  }

  // ── Step 6: cwd query param → validate → ctx.cwd ─────────────────────────
  // cwd is required for tool routes and context-block routes.
  // /batch/:batchId and /clarifications/confirm do NOT require cwd.
  let cwdValue: string | undefined;
  const urlObj = new URL(rawUrl, 'http://localhost');

  // Match against pathname prefix patterns for cwd-required routes
  const requiresCwd = CWD_REQUIRED_PATHS.has(pathname) ||
    pathname === '/context-blocks' ||
    /^\/context-blocks\//.test(pathname);

  if (requiresCwd) {
    const cwdParam = urlObj.searchParams.get('cwd') ?? undefined;
    const cwdResult = validateCwd(cwdParam);
    if (!cwdResult.ok) {
      const statusCode = cwdResult.error === 'forbidden_cwd' ? 403 : 400;
      sendError(res, statusCode, cwdResult.error, cwdResult.message);
      return;
    }
    cwdValue = cwdResult.canonicalCwd;
  }

  // ── Steps 7-9: Zod validation, project registry, and handler run ──────────
  // These happen inside each handler (Phase 6+).
  const ctx: RequestContext = {
    url: urlObj,
    cwd: cwdValue,
    body: parsedBody,
    authed: !AUTH_EXEMPT_PATHS.has(pathname),
  };

  await match.handler(req, res, match.params, ctx);
}
