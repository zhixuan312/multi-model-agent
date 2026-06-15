import { HTTPListener } from '@zhixuan92/multi-model-agent-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { Recorder } from '../telemetry/recorder.js';
import { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
import { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import { LogWriter } from '@zhixuan92/multi-model-agent-core/events/log-writer';
import { TelemetryUploader } from '@zhixuan92/multi-model-agent-core/events/telemetry-uploader';
import { StderrLogSubscriber } from '@zhixuan92/multi-model-agent-core/events/stderr-log-subscriber';
import { decideConsent } from '@zhixuan92/multi-model-agent-core/events/consent-rules';
import { normalizeModel } from '@zhixuan92/multi-model-agent-core';
import type { RawHandler } from './types.js';
import type { HandlerDeps } from './handler-deps.js';
import type { SkillManifestSync } from '../skill-install/skill-manifest-sync.js';
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
  /** Shared TaskRegistry — exposed for testing and introspection handlers. */
  taskRegistry: TaskRegistry;
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
  '/task',
  '/context-blocks',
]);

/** Routes that require the X-MMA-Main-Model header. Enforced at request boundary
 *  so wire telemetry's main_model column is never null for billed runs. The
 *  tool routes need it; the introspection / task-polling / context-block
 *  utility routes do not. */
const MAIN_MODEL_REQUIRED_PATHS = new Set([
  '/task',
]);

/**
 * Registers control handlers (POST/DELETE /context-blocks).
 */
async function registerControlHandlers(
  router: RouteDispatcher<RawHandler>,
  config: ServerConfig,
  taskRegistry: TaskRegistry,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');

  const multiModelConfig = (config as unknown as { agents?: unknown }).agents
    ? (config as unknown as HandlerDeps['config'])
    : undefined;

  if (multiModelConfig) {
    const bus = new EnvelopeBus();
    const logWriter = new LogWriter({ diagnosticsLog: multiModelConfig.diagnostics?.log ?? false, logDir: multiModelConfig.diagnostics?.logDir });
    bus.subscribe(logWriter);
    bus.subscribe(new StderrLogSubscriber());

    let recorderForBus: Recorder | null = null;
    try { recorderForBus = getRecorder(); } catch { /* not initialized */ }
    const decideConsentForUploader = () => {
      const envVal = process.env.MMA_TELEMETRY;
      let configState: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
      try {
        const cfgPath = join(homedir(), '.mma', 'config.json');
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
        mainModelFamily: env.mainModel ? normalizeModel(env.mainModel).family : 'other',
      }),
    });
    bus.subscribe(uploader);

    router.register('POST', '/context-blocks', buildCreateContextBlockHandler({
      projectRegistry,
      maxContextBlockBytes: multiModelConfig.server.limits.maxContextBlockBytes,
      maxContextBlocksPerProject: multiModelConfig.server.limits.maxContextBlocksPerProject,
    }));
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  } else {
    router.register('POST', '/context-blocks', (_req, res) => {
      sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
    });
    router.register('DELETE', '/context-blocks/:blockId', buildDeleteContextBlockHandler({ projectRegistry }));
  }
}

export async function startServer(
  config: ServerConfig,
  injectedManifestSync?: SkillManifestSync,
  configPath?: string,
): Promise<RunningServer> {
  const token = loadToken(config.server.auth.tokenFile);

  const router = new RouteDispatcher<RawHandler>();

  // ── Create shared registries ───────────────────────────────────────────────
  const { TaskRegistry } = await import('@zhixuan92/multi-model-agent-core');
  const { ProjectRegistry } = await import('./project-registry.js');

  const taskRegistry = new TaskRegistry();

  const projectRegistry = new ProjectRegistry({
    cap: config.server.limits.projectCap,
    idleEvictionMs: config.server.limits.idleProjectTimeoutMs,
    evictionIntervalMs: Math.min(config.server.limits.idleProjectTimeoutMs, 60_000),
  });

  // Capture serverStartedAt before health registration so /health can expose it.
  const serverStartedAt = Date.now();

  // GET /health — unauthenticated liveness + skill manifest drift check
  const { buildHealthHandler } = await import('./handlers/introspection/health.js');
  let skillManifestSync: SkillManifestSync;
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

  // Register control handlers
  await registerControlHandlers(router, config, taskRegistry, projectRegistry);

  // Register unified task handler (POST /task, GET /task/:taskId)
  {
    const multiModelConfig = (config as unknown as { agents?: unknown }).agents
      ? (config as unknown as HandlerDeps['config'])
      : undefined;

    if (multiModelConfig) {
      const bus = new EnvelopeBus();
      const logWriter = new LogWriter({
        diagnosticsLog: multiModelConfig.diagnostics?.log ?? false,
        logDir: multiModelConfig.diagnostics?.logDir,
      });
      bus.subscribe(logWriter);
      bus.subscribe(new StderrLogSubscriber());

      // Wire TelemetryUploader so unified-handler tasks emit wire records.
      let recorderForUnified: Recorder | null = null;
      try { recorderForUnified = getRecorder(); } catch { /* not initialized */ }
      const decideConsentForUnified = () => {
        const envVal = process.env.MMA_TELEMETRY;
        let configState: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
        try {
          const cfgPath = join(homedir(), '.mma', 'config.json');
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
      bus.subscribe(new TelemetryUploader({
        recorder: recorderForUnified,
        consent: { decide: decideConsentForUnified },
        buildOpts: (env: any) => ({
          toolMode: 'full',
          implementerModel: env.stages[0]?.model ?? env.mainModel,
          implementerTier: env.stages[0]?.tier ?? env.agentType,
          mainModelFamily: env.mainModel ? normalizeModel(env.mainModel).family : 'other',
        }),
      }));

      const deps: HandlerDeps = { config: multiModelConfig, bus, logWriter, projectRegistry, taskRegistry };
      const { buildUnifiedTaskHandler, buildTaskPollHandler } = await import('./handlers/unified-task.js');
      router.register('POST', '/task', buildUnifiedTaskHandler(deps));
      router.register('GET', '/task/:taskId', buildTaskPollHandler(deps));
    } else {
      router.register('POST', '/task', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
      });
      router.register('GET', '/task/:taskId', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
      });
    }
  }

  // POST /configure-provider — validate (dryRun=true) or validate+apply (dryRun=false)
  {
    const multiModelConfigForProvider = (config as unknown as { agents?: unknown }).agents
      ? (config as unknown as HandlerDeps['config'])
      : undefined;
    const { buildConfigureProviderHandler } = await import('./handlers/introspection/configure-provider.js');
    router.register('POST', '/configure-provider', buildConfigureProviderHandler(multiModelConfigForProvider, configPath));
  }

  // GET /status — operator introspection (registered after registries are ready)
  const { buildStatusHandler } = await import('./handlers/introspection/status.js');
  router.register('GET', '/status', buildStatusHandler({
    taskRegistry,
    projectRegistry,
    serverStartedAt,
    bind: config.server.bind,
    version: SERVER_VERSION,
  }));

  // Test-only: enumerates registered routes. Guarded by env; zero impact on production.
  if (process.env.MMA_TEST_INTROSPECTION === '1') {
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
    taskRegistry,
    projectRegistry,
    serverStartedAt,
  };
}

// Per-request pipeline lives in request-pipeline.ts. server.ts owns routing
// table + bootstrap; the pipeline owns body-cap -> route -> loopback -> auth ->
// JSON parse -> cwd -> dispatch.
const PIPELINE_CFG = {
  loopbackOnlyPaths: LOOPBACK_ONLY_PATHS,
  authExemptPaths: AUTH_EXEMPT_PATHS,
  cwdRequiredPaths: CWD_REQUIRED_PATHS,
  mainModelRequiredPaths: MAIN_MODEL_REQUIRED_PATHS,
};
