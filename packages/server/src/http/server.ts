import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ServerConfig, BatchRegistry } from '@zhixuan92/multi-model-agent-core';
import { EventEmitter, LocalLogSink, TelemetrySink, JsonlWriter } from '@zhixuan92/multi-model-agent-core';
import { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
import type { RawHandler } from './types.js';
import { sendError, sendJson } from './errors.js';
import { loadToken } from './auth.js';
import type { ProjectRegistry } from './project-registry.js';
import { handleRequest } from './request-pipeline.js';
import { getRecorder } from '../telemetry/recorder.js';

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

export const SERVER_VERSION = readServerVersion();

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
  '/delegate', '/audit', '/review', '/verify', '/debug', '/execute-plan', '/retry', '/investigate', '/explore',
  '/control/retry', '/control/batch-slice', '/context-blocks', '/register-context-block',
]);

/**
 * Registers tool handlers (POST /delegate, /audit, /review, /verify, /debug, /execute-plan, /retry).
 * Builds a ToolSurfaceRegistry by calling each tool-config's registerXxx, then
 * iterates `registry.list()` filtered to `surface: 'tool'` entries to drive
 * route registration. The registry is the canonical source for tool surface
 * metadata (httpMethod, httpPath, schema, toolCategory).
 */
async function registerToolHandlers(
  router: RouteDispatcher<RawHandler>,
  config: ServerConfig,
  batchRegistry: BatchRegistry,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildToolSurfaceRegistry, LifecycleDispatcher, createHttpServerLog, ReviewerEngine, ReviewerPromptBuilder, AnnotatorEngine,
    specTemplate, qualityAPTemplate, diffTemplate,
    qualityAuditTemplate, qualityReviewTemplate, qualityVerifyTemplate, qualityDebugTemplate, qualityInvestigateTemplate,
  } =
    await import('@zhixuan92/multi-model-agent-core');

  const surface = buildToolSurfaceRegistry();

  // For tool handlers, we need MultiModelConfig which is part of ServerConfig only
  // when the full mmagent.config.json is loaded. In test/minimal configs that only
  // have `server:`, we create a stub config. Real CLI startup will load full config.
  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
    : undefined;

  if (!multiModelConfig) {
    // Server started with server-only config (e.g. tests): register stubs that return 503.
    // Drive registration from the registry so adding a tool only requires a tool-config edit.
    for (const entry of surface.list()) {
      if (entry.surface !== 'tool') continue;
      router.register(entry.httpMethod, entry.httpPath, (_req, res, _params, _ctx) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
      });
    }
    return;
  }

  const logDir = multiModelConfig.diagnostics?.logDir ?? join(homedir(), '.multi-model', 'logs');
  const writer = new JsonlWriter({ dir: logDir });

  const logger = createHttpServerLog({
    enabled: multiModelConfig.diagnostics?.log ?? false,
    writer,
  });

  // Wire TelemetrySink to the server Recorder when telemetry is initialized
  // (the serve.ts entrypoint calls createRecorder before this code path).
  // Tests that exercise http/server.ts without initializing telemetry get
  // a null sink — TelemetrySink no-ops cleanly when its recorder is null.
  let recorderForBus: Awaited<ReturnType<typeof getRecorder>> | null = null;
  try { recorderForBus = getRecorder(); } catch { /* not initialized — telemetry disabled */ }
  const bus = new EventEmitter([
    new LocalLogSink(writer),
    new TelemetrySink(recorderForBus),
  ]);

  const routeDispatcher = new LifecycleDispatcher();

  const reviewerEngine = new ReviewerEngine(new ReviewerPromptBuilder(
    { spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate },
    {
      delegate: qualityAPTemplate,
      'execute-plan': qualityAPTemplate,
      audit: qualityAuditTemplate,
      review: qualityReviewTemplate,
      verify: qualityVerifyTemplate,
      debug: qualityDebugTemplate,
      investigate: qualityInvestigateTemplate,
    },
  ));
  const annotatorEngine = new AnnotatorEngine();

  const deps: import('./handler-deps.js').HandlerDeps = {
    config: multiModelConfig,
    logger,
    bus,
    projectRegistry,
    batchRegistry,
    routeDispatcher,
    reviewerEngine,
    annotatorEngine,
  };

  // Per-tool handler builders, keyed by registry routeName. The registry tells
  // us WHICH route to register and at WHICH path/method; this map answers HOW
  // to build the per-tool handler.
  const { buildDelegateHandler } = await import('./handlers/tools/delegate.js');
  const { buildAuditHandler } = await import('./handlers/tools/audit.js');
  const { buildReviewHandler } = await import('./handlers/tools/review.js');
  const { buildVerifyHandler } = await import('./handlers/tools/verify.js');
  const { buildDebugHandler } = await import('./handlers/tools/debug.js');
  const { buildExecutePlanHandler } = await import('./handlers/tools/execute-plan.js');
  const { buildRetryHandler } = await import('./handlers/tools/retry.js');
  const { buildInvestigateHandler } = await import('./handlers/tools/investigate.js');
  const { buildExploreHandler } = await import('./handlers/tools/explore.js');

  const builders: Record<string, (d: import('./handler-deps.js').HandlerDeps) => RawHandler> = {
    delegate: buildDelegateHandler,
    audit: buildAuditHandler,
    review: buildReviewHandler,
    verify: buildVerifyHandler,
    debug: buildDebugHandler,
    execute_plan: buildExecutePlanHandler,
    retry_tasks: buildRetryHandler,
    investigate: buildInvestigateHandler,
    explore: buildExploreHandler,
  };

  for (const entry of surface.list()) {
    if (entry.surface !== 'tool') continue;
    const builder = builders[entry.routeName];
    if (!builder) {
      throw new Error(`registerToolHandlers: no handler builder registered for route '${entry.routeName}'`);
    }
    router.register(entry.httpMethod, entry.httpPath, builder(deps));
  }
}

/**
 * Registers control handlers (GET /batch/:batchId, POST/DELETE /context-blocks).
 */
async function registerControlHandlers(
  router: RouteDispatcher<RawHandler>,
  config: ServerConfig,
  batchRegistry: BatchRegistry,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildBatchHandler } = await import('./handlers/control/batch.js');
  const { buildRetryHandler } = await import('./handlers/control/retry.js');
  const { buildBatchSliceHandler } = await import('./handlers/control/batch-slice.js');
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');
  const { createHttpServerLog } = await import('@zhixuan92/multi-model-agent-core');

  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
    : undefined;

  router.register('GET', '/batch/:batchId', buildBatchHandler({ batchRegistry }));
  if (multiModelConfig) {
    const writer = new JsonlWriter({ dir: multiModelConfig.diagnostics?.logDir ?? join(homedir(), '.multi-model', 'logs') });
    let recorderForBus: Awaited<ReturnType<typeof getRecorder>> | null = null;
    try { recorderForBus = getRecorder(); } catch { /* not initialized — telemetry disabled */ }
    const bus = new EventEmitter([
      new LocalLogSink(writer),
      new TelemetrySink(recorderForBus),
    ]);
    const { LifecycleDispatcher, ReviewerEngine, ReviewerPromptBuilder, AnnotatorEngine,
      specTemplate, qualityAPTemplate, diffTemplate,
      qualityAuditTemplate, qualityReviewTemplate, qualityVerifyTemplate, qualityDebugTemplate, qualityInvestigateTemplate,
    } = await import('@zhixuan92/multi-model-agent-core');
    const routeDispatcher = new LifecycleDispatcher();
    const reviewerEngine = new ReviewerEngine(new ReviewerPromptBuilder(
      { spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate },
      {
        delegate: qualityAPTemplate,
        'execute-plan': qualityAPTemplate,
        audit: qualityAuditTemplate,
        review: qualityReviewTemplate,
        verify: qualityVerifyTemplate,
        debug: qualityDebugTemplate,
        investigate: qualityInvestigateTemplate,
      },
    ));
    const annotatorEngine = new AnnotatorEngine();
    const deps: import('./handler-deps.js').HandlerDeps = {
      config: multiModelConfig,
      logger: createHttpServerLog({
        enabled: multiModelConfig.diagnostics?.log ?? false,
        writer,
      }),
      bus,
      projectRegistry,
      batchRegistry,
      routeDispatcher,
      reviewerEngine,
      annotatorEngine,
    };
    router.register('POST', '/control/retry', buildRetryHandler(deps));
    router.register('POST', '/control/batch-slice', buildBatchSliceHandler(deps));
    router.register('POST', '/context-blocks', buildCreateContextBlockHandler({
      projectRegistry,
      routeDispatcher,
      maxContextBlockBytes: multiModelConfig.server.limits.maxContextBlockBytes,
      maxContextBlocksPerProject: multiModelConfig.server.limits.maxContextBlocksPerProject,
    }));
    router.register('POST', '/register-context-block', buildCreateContextBlockHandler({
      projectRegistry,
      routeDispatcher,
      maxContextBlockBytes: multiModelConfig.server.limits.maxContextBlockBytes,
      maxContextBlocksPerProject: multiModelConfig.server.limits.maxContextBlocksPerProject,
    }));
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  } else {
    router.register('POST', '/control/retry', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('POST', '/control/batch-slice', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('POST', '/context-blocks', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('POST', '/register-context-block', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  }
}

export async function startServer(
  config: ServerConfig,
  injectedManifestSync?: import('@zhixuan92/multi-model-agent-core/tool-surface/skill-manifest-sync').SkillManifestSync,
): Promise<RunningServer> {
  const token = loadToken(config.server.auth.tokenFile);

  const router = new RouteDispatcher<RawHandler>();

  // ── Create shared registries ───────────────────────────────────────────────
  const { BatchRegistry } = await import('@zhixuan92/multi-model-agent-core');
  const { ProjectRegistry } = await import('./project-registry.js');

  const batchRegistry = new BatchRegistry({
    batchTtlMs: config.server.limits.batchTtlMs,
  });

  const projectRegistry = new ProjectRegistry({
    cap: config.server.limits.projectCap,
    idleEvictionMs: config.server.limits.idleProjectTimeoutMs,
    evictionIntervalMs: Math.min(config.server.limits.idleProjectTimeoutMs, 60_000),
  });

  // Capture serverStartedAt before health registration so /health can expose it.
  const serverStartedAt = Date.now();

  // GET /health — unauthenticated liveness + skill manifest drift check
  const { buildHealthHandler } = await import('./handlers/introspection/health.js');
  let skillManifestSync: import('@zhixuan92/multi-model-agent-core/tool-surface/skill-manifest-sync').SkillManifestSync;
  if (injectedManifestSync) {
    skillManifestSync = injectedManifestSync;
  } else {
    try {
      const { makeSkillManifestSync } = await import('@zhixuan92/multi-model-agent-core/tool-surface/skill-manifest-sync');
      const { discoverPerClientInstallDirs } = await import('@zhixuan92/multi-model-agent-core/tool-surface/discover');
      skillManifestSync = makeSkillManifestSync(discoverPerClientInstallDirs());
    } catch {
      skillManifestSync = { driftReport: () => [] };
    }
  }
  router.register('GET', '/health', buildHealthHandler({ manifestSync: skillManifestSync }));

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

  // GET /openapi — canonical OpenAPI route per spec C13 (same handler as /tools)
  router.register('GET', '/openapi', buildToolsHandler());

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
