import { HTTPListener } from '@zhixuan92/multi-model-agent-core';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readServerVersion } from '../server-version.js';
import type { ServerConfig, RunnableConfig, MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { assertRunnable } from '@zhixuan92/multi-model-agent-core';
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { Recorder } from '../telemetry/recorder.js';
import { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
import { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import { LogWriter } from '@zhixuan92/multi-model-agent-core/events/log-writer';
import { TelemetryUploader } from '@zhixuan92/multi-model-agent-core/events/telemetry-uploader';
import { StderrLogSubscriber } from '@zhixuan92/multi-model-agent-core/events/stderr-log-subscriber';
import { normalizeModel } from '@zhixuan92/multi-model-agent-core';
import { decide as decideConsent } from '../telemetry/consent.js';
import type { RawHandler } from './types.js';
import type { HandlerDeps } from './handler-deps.js';
import type { SkillManifestSync } from './handlers/introspection/health.js';
import type { ProvisioningService } from '../provisioning/service.js';
import { sendError, sendJson } from './errors.js';
import { loadToken } from './auth.js';
import { expandHome } from '../expand-home.js';
import type { ProjectRegistry } from '../application/project-registry.js';
import type { InitiativeRecordRuntime } from '../application/initiative-record-runtime.js';
import { handleRequest } from './request-pipeline.js';
import { getRecorder } from '../telemetry/recorder.js';

/** Server package version — read once at module load time (single source: server-version.ts). */
export const SERVER_VERSION = readServerVersion();

/** The tier check here IS the RunnableConfig narrowing — a config without tiers
 *  cannot drive a runtime, and every caller already treats `undefined` as "no
 *  tool handlers". Saying so in the return type removes the need for callers to
 *  re-prove it.
 *
 *  Absent `agents` and PARTIAL `agents` are different states and must fail
 *  differently. Absent is legitimate (a provisioning-only daemon records a
 *  client roster before any model is chosen), so it yields `undefined` and no
 *  tool handlers. Partial is a broken config, and it must throw HERE: this
 *  function is the only narrowing gate for `startServer`, which `mma serve`
 *  reaches AFTER `assertRunnable` but every direct caller reaches without it.
 *  Casting a partial block to `RunnableConfig` handed the runtime a config whose
 *  `agents.main` does not exist, and the failure surfaced much later as an
 *  unhandled TypeError while pricing a finished run — long after the point where
 *  the config could be named as the cause. */
function extractMultiModelConfig(config: ServerConfig): RunnableConfig | undefined {
  const candidate = config as unknown as { agents?: unknown };
  if (!candidate.agents) return undefined;
  assertRunnable(candidate as MultiModelConfig);
  return config as unknown as RunnableConfig;
}

export interface RunningServer {
  port: number;
  /** The resolved address the server is bound to. Used by CLI to log the actual listen address. */
  serverAddress: string | null;
  stop(): Promise<void>;
  /** Shared TaskRegistry — exposed for testing and introspection handlers. */
  taskRegistry: TaskRegistry;
  /** Shared ProjectRegistry — exposed for testing and introspection handlers. */
  projectRegistry: ProjectRegistry;
  /** Shared InitiativeRecordRuntime over `<stateDir>/initiatives.db` — the one
   *  application service Group 001B's HTTP, MCP, and CLI adapters depend on. */
  initiativeRuntime: InitiativeRecordRuntime;
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

/** Routes that require the X-MMA-Client header, so wire telemetry's `client`
 *  column is never anonymous for a billed run. Tool routes need it; the
 *  introspection / task-polling / context-block utility routes do not. */
const CLIENT_REQUIRED_PATHS = new Set([
  '/task',
]);

/**
 * Registers control handlers (POST/DELETE /context-blocks).
 */
async function registerControlHandlers(
  router: RouteDispatcher<RawHandler>,
  config: ServerConfig,
  projectRegistry: ProjectRegistry,
): Promise<void> {
  const { buildCreateContextBlockHandler, buildDeleteContextBlockHandler } = await import('./handlers/control/context-blocks.js');

  const multiModelConfig = extractMultiModelConfig(config);

  if (multiModelConfig) {
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

  // ── Create shared registries + durable execution store ────────────────────
  const { TaskRegistry } = await import('@zhixuan92/multi-model-agent-core');
  const { ProjectRegistry } = await import('../application/project-registry.js');
  const { ExecutionStore } = await import('../application/execution-store.js');
  const { reconcileOnBoot } = await import('../application/reconcile.js');

  // batchTtlMs bounds how long terminal task entries (with their full result
  // envelope) are retained for polling before eviction — prevents unbounded
  // growth of the task registry on a long-running server.
  const taskRegistry = new TaskRegistry({ ttlMs: config.server.limits.batchTtlMs });

  // Durable execution records: task IDs + terminal results survive a restart;
  // the same TTL governs both the in-memory entries and the persistent rows.
  const executionStore = new ExecutionStore({
    dbPath: join(expandHome(config.server.stateDir), 'executions.db'),
    ttlMs: config.server.limits.batchTtlMs,
  });

  // Shared Initiative Record runtime — a SEPARATE database (`initiatives.db`)
  // and lifecycle from `executionStore`/`executions.db` above. Opened
  // unconditionally (like executionStore) so it is ready before Group 001B's
  // HTTP/MCP adapters are wired, regardless of whether agent config is present.
  const { InitiativeRecordRuntime } = await import('../application/initiative-record-runtime.js');
  const initiativeRuntime = InitiativeRecordRuntime.open({ stateDir: config.server.stateDir });

  // Boot reconciliation — BEFORE the listener accepts requests: fence worker
  // process groups that survived a dead daemon, then mark their executions
  // `interrupted` (retryable). Guarded for dev watch mode (PD-2): under
  // `tsx watch` every file save restarts the process, and reconciling there
  // would SIGKILL in-flight work on each keystroke.
  if (process.env.MMA_DEV_NO_RECONCILE !== '1') {
    const outcome = reconcileOnBoot(executionStore);
    if (outcome.interrupted > 0 || outcome.fencedWorkers > 0) {
      process.stderr.write(
        `[mma] event=boot_reconcile ts=${new Date().toISOString()} interrupted=${outcome.interrupted} fenced_workers=${outcome.fencedWorkers} pruned=${outcome.prunedExpired}\n`,
      );
    }
  }

  // Resolve any client provisioning marker left behind by a crashed prior
  // daemon BEFORE anything (including GET /health below) reads the
  // inventory — an unresolved marker must never be mistaken for "healthy".
  // Same dev-watch guard as boot reconciliation above: under `tsx watch`
  // every save restarts the process, and recovering there would race a
  // provisioning call the developer just triggered by hand.
  let provisioningService: ProvisioningService | undefined;
  if (process.env.MMA_DEV_NO_RECONCILE !== '1') {
    try {
      const { buildProvisioningService } = await import('../provisioning/runtime-deps.js');
      provisioningService = buildProvisioningService(config);
      const reports = await provisioningService.recoverOnStartup();
      const unresolved = reports.filter((report) => !report.resolved);
      if (unresolved.length > 0) {
        process.stderr.write(
          `[mma] event=boot_provisioning_recovery ts=${new Date().toISOString()} unresolved=${unresolved.map((r) => r.clientId).join(',')}\n`,
        );
      }
    } catch {
      // Best-effort: provisioning recovery must never block the daemon from
      // starting -- an unresolved marker still shows up as 'failed' in the
      // inventory GET /health reads below.
    }
  }

  const projectRegistry = new ProjectRegistry({
    cap: config.server.limits.projectCap,
    // A project with active tasks must never be evicted to make room at cap.
    isBusy: (cwd) => taskRegistry.countActive(cwd) > 0,
  });

  // Capture serverStartedAt before health registration so /health can expose it.
  const serverStartedAt = Date.now();

  // GET /health — unauthenticated liveness + client provisioning drift check.
  // Reads the SAME inventory boot recovery (above) resolved every marker
  // against -- an unresolved marker reports 'failed' here, never silently 'ok'.
  const { buildHealthHandler } = await import('./handlers/introspection/health.js');
  let skillManifestSync: SkillManifestSync;
  if (injectedManifestSync) {
    skillManifestSync = injectedManifestSync;
  } else {
    const service = provisioningService;
    skillManifestSync = {
      async driftReport() {
        if (!service) return [];
        const records = await service.inventory();
        return records
          .filter((record) => record.status === 'failed')
          .map((record) => ({ skill: 'provisioning', client: record.clientId, issue: 'failed' as const }));
      },
    };
  }
  router.register('GET', '/health', buildHealthHandler({ manifestSync: skillManifestSync }));

  // Register control handlers
  await registerControlHandlers(router, config, projectRegistry);

  // Register unified task handler (POST /task, GET /task/:taskId)
  {
    const multiModelConfig = extractMultiModelConfig(config);

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
      // Consent decision is owned by telemetry/consent.ts (single source of truth for the
      // env + config.json → decision logic); reuse it here rather than re-implementing it.
      bus.subscribe(new TelemetryUploader({
        recorder: recorderForUnified,
        consent: { decide: () => decideConsent(join(homedir(), '.mma')) },
        buildOpts: (env: any) => ({
          toolMode: 'full',
          implementerModel: env.stages[0]?.model ?? env.mainModel,
          implementerTier: env.stages[0]?.tier ?? env.agentType,
          mainModelFamily: env.mainModel ? normalizeModel(env.mainModel).family : 'other',
        }),
      }));

      // Persist detached codex worker pids so boot reconciliation can fence
      // stragglers that outlive a crashed daemon.
      const { WorkerPidRecorder } = await import('../application/worker-pid-recorder.js');
      bus.subscribe(new WorkerPidRecorder(executionStore));

      const { ExecutionRuntime } = await import('../application/execution-runtime.js');
      const runtime = new ExecutionRuntime({ config: multiModelConfig, bus, taskRegistry, projectRegistry, store: executionStore });
      const deps: HandlerDeps = { runtime, taskRegistry, store: executionStore, initiativeRuntime };
      const { buildUnifiedTaskHandler, buildTaskPollHandler, buildTaskCancelHandler } = await import('./handlers/unified-task.js');
      router.register('POST', '/task', buildUnifiedTaskHandler(deps));
      router.register('GET', '/task/:taskId', buildTaskPollHandler(deps));
      router.register('DELETE', '/task/:taskId', buildTaskCancelHandler(deps));

      // POST /initiatives — the single HTTP adapter for the complete frozen
      // Initiative operation table, over the SAME `initiativeRuntime` opened
      // unconditionally above. Behind the standard bearer-auth/loopback
      // pipeline like every other route; not added to any auth exemption set.
      const { buildInitiativeHandler } = await import('./handlers/initiative-record.js');
      router.register('POST', '/initiatives', buildInitiativeHandler(deps));

      // MCP adapter — a second transport over the SAME runtime (single daemon
      // owns all live executions). Bearer auth + loopback apply like any route.
      const { handleMcpRequest } = await import('../mcp/mcp-adapter.js');
      const { resolveMcpCapabilities } = await import('../mcp/tool-surface.js');
      const { getExecutionArtifact } = await import('../mcp/execution-artifact.js');
      // Resolved EXACTLY ONCE, here, before the route is registered — never
      // recomputed per request (buildMcpServer just reads the same reference off
      // deps, so discover and initialize can never disagree within this process).
      const capabilities = resolveMcpCapabilities(getExecutionArtifact().available);
      if (!('resources' in capabilities)) {
        process.stderr.write(
          `[mma] event=mcp_capabilities_degraded ts=${new Date().toISOString()} reason=execution_artifact_unavailable\n`,
        );
      }
      const mcpDeps = {
        runtime,
        taskRegistry,
        store: executionStore,
        // Same open InitiativeRecordRuntime `POST /initiatives` (Task I-6) uses —
        // the `mma_<operation>` Initiative tools (Task I-7) are a second thin
        // transport over it, never a second store/runtime.
        initiativeRuntime,
        serverVersion: SERVER_VERSION,
        capabilities,
        projectRegistry,
        maxContextBlockBytes: multiModelConfig.server.limits.maxContextBlockBytes,
        maxContextBlocksPerProject: multiModelConfig.server.limits.maxContextBlocksPerProject,
      };
      router.register('POST', '/mcp', (req, res, _params, ctx) => handleMcpRequest(mcpDeps, req, res, ctx.body));
    } else {
      router.register('POST', '/task', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
      });
      router.register('GET', '/task/:taskId', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
      });
      router.register('DELETE', '/task/:taskId', (_req, res) => {
        sendError(res, 503, 'no_agent_config', 'Server started without agent configuration; provide a full mma.config.json');
      });
    }
  }

  // POST /configure-provider — validate (dryRun=true) or validate+apply (dryRun=false)
  {
    const multiModelConfigForProvider = extractMultiModelConfig(config);
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
    config: extractMultiModelConfig(config),
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
    stop: async () => {
      await listener.stop();
      executionStore.close();
      initiativeRuntime.close();
    },
    taskRegistry,
    projectRegistry,
    initiativeRuntime,
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
  clientRequiredPaths: CLIENT_REQUIRED_PATHS,
};
