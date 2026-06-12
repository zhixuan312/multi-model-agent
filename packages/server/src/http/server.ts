import { HTTPListener } from '@zhixuan92/multi-model-agent-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ServerConfig, BatchRegistry } from '@zhixuan92/multi-model-agent-core';
import type { Recorder } from '../telemetry/recorder.js';
import { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
import { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import { LogWriter } from '@zhixuan92/multi-model-agent-core/events/log-writer';
import { TelemetryUploader } from '@zhixuan92/multi-model-agent-core/events/telemetry-uploader';
import { StderrLogSubscriber } from '@zhixuan92/multi-model-agent-core/events/stderr-log-subscriber';
import { decideConsent } from '@zhixuan92/multi-model-agent-core/events/consent-rules';
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
  '/delegate', '/audit', '/review', '/debug', '/execute-plan', '/retry', '/investigate', '/research', '/journal-record', '/journal-recall',
  '/task',
  '/control/batch-slice', '/context-blocks',
]);

/** Routes that require the X-MMA-Main-Model header. Enforced at request boundary
 *  so wire telemetry's main_model column is never null for billed runs. The
 *  tool routes need it; the introspection / batch-polling / context-block
 *  utility routes do not. */
const MAIN_MODEL_REQUIRED_PATHS = new Set([
  '/delegate', '/audit', '/review', '/debug', '/execute-plan', '/retry', '/investigate', '/research', '/journal-record', '/journal-recall',
  '/task',
]);

/**
 * Registers tool handlers (POST /delegate, /audit, /review, /debug, /execute-plan, /retry).
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
  const { buildToolSurfaceRegistry } =
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

  const bus = new EnvelopeBus();
  const logWriter = new LogWriter({ diagnosticsLog: multiModelConfig.diagnostics?.log ?? false, logDir: multiModelConfig.diagnostics?.logDir });
  bus.subscribe(logWriter);
  // Always-on stderr log stream — no quiet mode and no --verbose flag (4.7.3+).
  bus.subscribe(new StderrLogSubscriber());

  let recorderForBus: Recorder | null = null;
  try { recorderForBus = getRecorder(); } catch { /* not initialized */ }
  // decideConsent signature: read from packages/server/src/telemetry/consent.ts. Today it reads
  // process.env.MMAGENT_TELEMETRY + a config.json. Replicate that call here:
  const decideConsentForUploader = () => {
    const envVal = process.env.MMAGENT_TELEMETRY;
    let configState: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
    try {
      const cfgPath = join(homedir(), '.multi-model', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg && typeof cfg === 'object' && cfg.telemetry && typeof cfg.telemetry === 'object' && typeof cfg.telemetry.enabled === 'boolean') {
        configState = { enabled: cfg.telemetry.enabled };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        configState = { kind: 'unreadable' };
      }
    }
    return decideConsent({ env: envVal, config: configState });
  };
  const uploader = new TelemetryUploader({
    recorder: recorderForBus,
    consent: { decide: decideConsentForUploader },
    buildOpts: (env: any) => ({
      toolMode: 'full',                     // default
      implementerModel: env.stages[0]?.model ?? env.mainModel,
      implementerTier: env.stages[0]?.tier ?? env.agentType,
      mainModelFamily: env.mainModel.split('-')[0] ?? 'unknown',
    }),
  });
  bus.subscribe(uploader);

  const deps: import('./handler-deps.js').HandlerDeps = { config: multiModelConfig, bus, logWriter, projectRegistry, batchRegistry };

  // Per-tool handler builders, keyed by registry routeName. The registry tells
  // us WHICH route to register and at WHICH path/method; this map answers HOW
  // to build the per-tool handler.
  const { buildDelegateHandler } = await import('./handlers/tools/delegate.js');
  const { buildAuditHandler } = await import('./handlers/tools/audit.js');
  const { buildReviewHandler } = await import('./handlers/tools/review.js');
  const { buildDebugHandler } = await import('./handlers/tools/debug.js');
  const { buildExecutePlanHandler } = await import('./handlers/tools/execute-plan.js');
  const { buildRetryHandler } = await import('./handlers/tools/retry.js');
  const { buildInvestigateHandler } = await import('./handlers/tools/investigate.js');
  const { buildResearchHandler } = await import('./handlers/tools/research.js');
  const { buildJournalRecordHandler } = await import('./handlers/tools/journal-record.js');
  const { buildJournalRecallHandler } = await import('./handlers/tools/journal-recall.js');

  const builders: Record<string, (d: import('./handler-deps.js').HandlerDeps) => RawHandler> = {
    delegate: buildDelegateHandler,
    audit: buildAuditHandler,
    review: buildReviewHandler,
    debug: buildDebugHandler,
    execute_plan: buildExecutePlanHandler,
    retry_tasks: buildRetryHandler,
    investigate: buildInvestigateHandler,
    research: buildResearchHandler,
    'journal-record': buildJournalRecordHandler,
    'journal-recall': buildJournalRecallHandler,
  };

  for (const entry of surface.list()) {
    if (entry.surface !== 'tool') continue;
    const builder = builders[entry.routeName];
    if (!builder) {
      // Route is in the registry but its handler hasn't been wired yet
      // (e.g. /research added in a prior task, handler lands in a later one).
      // Skip silently — the next task wires the handler and enables the route.
      continue;
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
  const { buildBatchSliceHandler } = await import('./handlers/control/batch-slice.js');
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');

  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
    : undefined;

  router.register('GET', '/batch/:batchId', buildBatchHandler({ batchRegistry }));
  if (multiModelConfig) {
    const bus = new EnvelopeBus();
    const logWriter = new LogWriter({ diagnosticsLog: multiModelConfig.diagnostics?.log ?? false, logDir: multiModelConfig.diagnostics?.logDir });
    bus.subscribe(logWriter);
    bus.subscribe(new StderrLogSubscriber());

    let recorderForBus: Recorder | null = null;
    try { recorderForBus = getRecorder(); } catch { /* not initialized */ }
    const decideConsentForUploader = () => {
      const envVal = process.env.MMAGENT_TELEMETRY;
      let configState: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
      try {
        const cfgPath = join(homedir(), '.multi-model', 'config.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (cfg && typeof cfg === 'object' && cfg.telemetry && typeof cfg.telemetry === 'object' && typeof cfg.telemetry.enabled === 'boolean') {
          configState = { enabled: cfg.telemetry.enabled };
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          configState = { kind: 'unreadable' };
        }
      }
      return decideConsent({ env: envVal, config: configState });
    };
    const uploader = new TelemetryUploader({
      recorder: recorderForBus,
      consent: { decide: decideConsentForUploader },
      buildOpts: (env: any) => ({
        toolMode: 'full',                     // default
        implementerModel: env.stages[0]?.model ?? env.mainModel,
        implementerTier: env.stages[0]?.tier ?? env.agentType,
        mainModelFamily: env.mainModel.split('-')[0] ?? 'unknown',
      }),
    });
    bus.subscribe(uploader);

    const deps: import('./handler-deps.js').HandlerDeps = { config: multiModelConfig, bus, logWriter, projectRegistry, batchRegistry };
    router.register('POST', '/control/batch-slice', buildBatchSliceHandler(deps));
    router.register('POST', '/context-blocks', buildCreateContextBlockHandler({
      projectRegistry,
      maxContextBlockBytes: multiModelConfig.server.limits.maxContextBlockBytes,
      maxContextBlocksPerProject: multiModelConfig.server.limits.maxContextBlocksPerProject,
    }));
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  } else {
    router.register('POST', '/control/batch-slice', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('POST', '/context-blocks', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
    });
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  }
}

export async function startServer(
  config: ServerConfig,
  injectedManifestSync?: import('../skill-install/skill-manifest-sync.js').SkillManifestSync,
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
  let skillManifestSync: import('../skill-install/skill-manifest-sync.js').SkillManifestSync;
  if (injectedManifestSync) {
    skillManifestSync = injectedManifestSync;
  } else {
    try {
      const { makeSkillManifestSync } = await import('../skill-install/skill-manifest-sync.js');
      const { discoverPerClientInstallDirs } = await import('../skill-install/discover.js');
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

  // Register unified task handler (POST /task, GET /task/:taskId)
  {
    const multiModelConfig = (config as unknown as { agents?: unknown }).agents
      ? (config as unknown as import('./handler-deps.js').HandlerDeps['config'])
      : undefined;

    if (multiModelConfig) {
      const bus = new EnvelopeBus();
      const logWriter = new LogWriter({
        diagnosticsLog: multiModelConfig.diagnostics?.log ?? false,
        logDir: multiModelConfig.diagnostics?.logDir,
      });
      bus.subscribe(logWriter);
      bus.subscribe(new StderrLogSubscriber());
      const deps: import('./handler-deps.js').HandlerDeps = { config: multiModelConfig, bus, logWriter, projectRegistry, batchRegistry };
      const { buildUnifiedTaskHandler, buildTaskPollHandler } = await import('./handlers/unified-task.js');
      router.register('POST', '/task', buildUnifiedTaskHandler(deps));
      router.register('GET', '/task/:taskId', buildTaskPollHandler(deps));
    } else {
      router.register('POST', '/task', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
      });
      router.register('GET', '/task/:taskId', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mmagent.config.json');
      });
    }
  }

  // GET /status — operator introspection (registered after registries are ready)
  const { buildStatusHandler } = await import('./handlers/introspection/status.js');
  router.register('GET', '/status', buildStatusHandler({
    batchRegistry,
    projectRegistry,
    serverStartedAt,
    bind: config.server.bind,
    version: SERVER_VERSION,
  }));

  // Test-only: enumerates registered routes. Guarded by env; zero impact on production.
  if (process.env.MMAGENT_TEST_INTROSPECTION === '1') {
    router.register('GET', '/__routes', (_req, res) => {
      sendJson(res, 200, router.listRoutes().map((route) => ({
        method: route.method.toUpperCase(),
        path: route.path,
      })));
    });
  }

  const listener = new HTTPListener({
    bind: config.server.bind,
    port: config.server.port,
    handler: (req, res) => handleRequest(router, token, req, res, config, PIPELINE_CFG),
  });
  const { port, address: serverAddress } = await listener.start();

  return {
    port,
    serverAddress,
    stop: () => listener.stop(),
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
  mainModelRequiredPaths: MAIN_MODEL_REQUIRED_PATHS,
};
