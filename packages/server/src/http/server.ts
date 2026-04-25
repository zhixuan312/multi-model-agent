import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ServerConfig, BatchRegistry } from '@zhixuan92/multi-model-agent-core';
import { Router } from './router.js';
import { sendError, sendJson } from './errors.js';
import { loadToken } from './auth.js';
import type { ProjectRegistry } from './project-registry.js';
import { handleRequest } from './request-pipeline.js';

/** Server package version — read once at module load time from package.json. */
function readServerVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // Walk up from src/http/ to packages/server/
    const pkgPath = join(thisDir, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();

export interface RunningServer {
  port: number;
  /** The resolved address the server is bound to. Used by CLI to log the actual listen address. */
  serverAddress: string | null;
  stop(): Promise<void>;
  /** Shared BatchRegistry — exposed for testing and introspection handlers. */
  batchRegistry: BatchRegistry;
  /** Shared ProjectRegistry — exposed for testing and introspection handlers. */
  projectRegistry: ProjectRegistry;
  /** Wall-clock ms when the server finished starting (Date.now()). Used for uptimeMs in /status. */
  serverStartedAt: number;
}

/** Routes where the loopback guard is enforced. */
const LOOPBACK_ONLY_PATHS = new Set(['/health', '/status']);

/** Routes that do NOT require bearer auth. */
const AUTH_EXEMPT_PATHS = new Set(['/health']);

/** Routes that require a `cwd` query parameter (validated by cwd-validator middleware). */
const CWD_REQUIRED_PATHS = new Set([
  '/delegate', '/tools/delegate', '/audit', '/review', '/verify', '/debug', '/execute-plan', '/retry',
  '/control/retry', '/control/batch-slice', '/context-blocks',
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

  const delegateHandler = buildDelegateHandler(deps);
  const auditHandler = buildAuditHandler(deps);
  const reviewHandler = buildReviewHandler(deps);
  const verifyHandler = buildVerifyHandler(deps);
  const debugHandler = buildDebugHandler(deps);
  const executePlanHandler = buildExecutePlanHandler(deps);
  const retryHandler = buildRetryHandler(deps);

  router.register('POST', '/delegate', delegateHandler);
  router.register('POST', '/tools/delegate', delegateHandler);
  router.register('POST', '/audit', auditHandler);
  router.register('POST', '/review', reviewHandler);
  router.register('POST', '/verify', verifyHandler);
  router.register('POST', '/debug', debugHandler);
  router.register('POST', '/execute-plan', executePlanHandler);
  router.register('POST', '/retry', retryHandler);
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
  const { buildRetryHandler } = await import('./handlers/control/retry.js');
  const { buildBatchSliceHandler } = await import('./handlers/control/batch-slice.js');
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');
  const { buildClarificationsHandler } = await import('./handlers/control/clarifications.js');
  const { createDiagnosticLogger } = await import('@zhixuan92/multi-model-agent-core');

  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
    : undefined;

  router.register('GET', '/batch/:batchId', buildBatchHandler({ batchRegistry }));
  if (multiModelConfig) {
    const deps: import('./handler-deps.js').HandlerDeps = {
      config: multiModelConfig,
      logger: createDiagnosticLogger({ enabled: false }),
      projectRegistry,
      batchRegistry,
    };
    router.register('POST', '/control/retry', buildRetryHandler(deps));
    router.register('POST', '/control/batch-slice', buildBatchSliceHandler(deps));
  } else {
    router.register('POST', '/control/retry', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('POST', '/control/batch-slice', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
  }
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

  // Capture serverStartedAt before health registration so /health can expose it.
  const serverStartedAt = Date.now();

  // GET /health — unauthenticated liveness + minimal identity
  const { buildHealthHandler } = await import('./handlers/introspection/health.js');
  router.register('GET', '/health', buildHealthHandler({ version: SERVER_VERSION, serverStartedAt }));

  // Register tool handlers (Phase 6)
  await registerToolHandlers(router, config, batchRegistry, projectRegistry);

  // Register control handlers (Phase 7)
  await registerControlHandlers(router, config, batchRegistry, projectRegistry);

  // GET /status — operator introspection (registered after registries are ready)
  const { buildStatusHandler } = await import('./handlers/introspection/status.js');
  router.register('GET', '/status', buildStatusHandler({
    batchRegistry,
    projectRegistry,
    serverStartedAt,
    bind: config.server.bind,
    version: SERVER_VERSION,
  }));

  // GET /tools — OpenAPI 3.0 document (auth required, NOT loopback-gated)
  const { buildToolsHandler } = await import('./handlers/introspection/tools-list.js');
  router.register('GET', '/tools', buildToolsHandler());

  // Test-only: enumerates registered routes. Guarded by env; zero impact on production.
  if (process.env.MMAGENT_TEST_INTROSPECTION === '1') {
    router.register('GET', '/__routes', (_req, res) => {
      sendJson(res, 200, router.listRoutes().map((route) => ({
        method: route.method.toUpperCase(),
        path: route.path,
      })));
    });
  }

  const server = createServer((req, res) => {
    void handleRequest(router, token, req, res, config, PIPELINE_CFG);
  });

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.bind, resolve);
  });

  const addr = server.address();
  const port = (addr as { port: number }).port;
  const serverAddress = typeof addr === 'object' && addr !== null ? (addr as { address?: string }).address ?? null : null;

  return {
    port,
    serverAddress,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    batchRegistry,
    projectRegistry,
    serverStartedAt,
  };
}

// Per-request pipeline lives in request-pipeline.ts. server.ts owns routing
// table + bootstrap; the pipeline owns body-cap → route → loopback → auth →
// JSON parse → cwd → dispatch.
const PIPELINE_CFG = {
  loopbackOnlyPaths: LOOPBACK_ONLY_PATHS,
  authExemptPaths: AUTH_EXEMPT_PATHS,
  cwdRequiredPaths: CWD_REQUIRED_PATHS,
};
