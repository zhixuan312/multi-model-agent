/**
 * serve.ts — starts the HTTP server and manages its signal lifecycle.
 *
 * This module owns the complete serve lifecycle: starting the HTTP server,
 * registering SIGTERM/SIGINT handlers, draining in-flight requests, and
 * cleanly exiting the process. The CLI entry point (cli/index.ts) delegates
 * to this module and does not manage signals directly.
 *
 * Usage (library):
 *   const handle = await startServe(config);
 *   // server is running on handle.port
 *   await handle.stop(); // graceful shutdown; no process.exit
 *
 * Usage (CLI):
 *   mma serve [--config <path>]
 *   // this module owns signal handling and process.exit
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { assertRunnable, collectInlineApiKeyOffenders, loadAuthToken, PortInUseError } from '@zhixuan92/multi-model-agent-core';
import { startServer, SERVER_VERSION } from '../http/server.js';
import { setDraining } from '../http/request-pipeline.js';
import { expandHome } from '../expand-home.js';
import { writePidfile, readPidfile, removePidfile } from '../pidfile.js';
import { createRecorder } from '../telemetry/recorder.js';
import { Flusher } from '../telemetry/flusher.js';
import { Queue } from '../telemetry/queue.js';
import { runSyncSkills } from './sync-skills.js';
import { listEntries, findMissingSkills, FutureManifestError } from '../skill-install/manifest.js';
import { SUPPORTED_SKILLS } from '../skill-install/discover.js';
import { isSkillBehind } from '../skill-install/skill-drift.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';

async function maybeAutoUpdateSkills(
  config: MultiModelConfig,
  stderr: (s: string) => boolean,
): Promise<void> {
  let entries;
  try {
    entries = listEntries();
  } catch (err) {
    if (err instanceof FutureManifestError) {
      stderr(`[mma] warning: ${err.message}; skipping skill auto-sync\n`);
      return;
    }
    return; // best-effort — never let manifest IO issues block serve
  }

  const behind = entries.filter((e) => isSkillBehind(e.name, e.skillVersion));
  const missing = findMissingSkills(entries, SUPPORTED_SKILLS as unknown as readonly string[]);
  // Orphans = installed skills that have since been removed from the bundle
  // (e.g. a retired task type like the old `mma-retry`). runSyncSkills Pass 1
  // drops these. Without orphans in the trigger below, a lone orphan (nothing
  // behind or missing) never prompts a sync and lingers across every restart.
  const orphans = entries.filter((e) => !(SUPPORTED_SKILLS as readonly string[]).includes(e.name));
  if (behind.length === 0 && missing.length === 0 && orphans.length === 0) return;

  if (!config.server.autoUpdateSkills) {
    const drift: string[] = [];
    if (behind.length > 0) drift.push(`${behind.length} out of date (${behind.map((e) => e.name).join(', ')})`);
    if (missing.length > 0) drift.push(`${missing.length} new (${missing.map((m) => m.name).join(', ')})`);
    if (orphans.length > 0) drift.push(`${orphans.length} removed (${orphans.map((e) => e.name).join(', ')})`);
    stderr(
      `[mma] skill drift: ${drift.join('; ')}. ` +
      `Run 'mma sync-skills' to reconcile (or set server.autoUpdateSkills=true in config).\n`,
    );
    return;
  }

  const deadlineMs = 5000;
  try {
    await Promise.race([
      runSyncSkills({
        silent: true,
        bestEffort: true,
        ifExists: true,
        declared: (config as unknown as { clients?: DeclaredClientRoster }).clients,
      }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), deadlineMs)),
    ]);
    if (behind.length > 0) process.stdout.write(`[mma] auto-synced ${behind.length} updated skill(s)\n`);
    if (missing.length > 0) process.stdout.write(`[mma] auto-synced ${missing.length} new skill(s): ${missing.map((m) => m.name).join(', ')}\n`);
    if (orphans.length > 0) process.stdout.write(`[mma] auto-removed ${orphans.length} orphaned skill(s): ${orphans.map((e) => e.name).join(', ')}\n`);
  } catch {
    // bestEffort swallows inside; extra safety here.
  }
}

function envVarHint(agentName: string): string {
  return `${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** A running server handle returned by startServe(). */
interface ServeHandle {
  /** The port the server is listening on (useful when port=0 for ephemeral). */
  port: number;
  /**
   * Gracefully shut down the server.
   * Removes any registered SIGTERM/SIGINT handlers to prevent leaks.
   * After this resolves, the process is no longer listening and may exit safely.
   */
  stop(): Promise<void>;
}

/**
 * Shared signal-state used to deduplicate shutdown if two signals arrive
 * before stop() resolves.
 */
let stopInFlight = false;

// Stored so they can be removed when stop() is called programmatically
let onSigterm: (() => void) | undefined;
let onSigint: (() => void) | undefined;
let onStdoutErrorRef: ((err: NodeJS.ErrnoException) => void) | undefined;
let onStderrErrorRef: ((err: NodeJS.ErrnoException) => void) | undefined;
let onUncaughtRef: ((err: unknown) => void) | undefined;
let onUnhandledRejectionRef: ((reason: unknown) => void) | undefined;

/**
 * Wait for in-flight tasks to finish, bounded by `server.limits.shutdownDrainMs`.
 *
 * Shutdown already refuses new dispatches before this runs, so the set can only
 * shrink. Polling is the right shape here rather than a completion hook: the
 * registry is the single source of truth for what is running, and a hook would
 * be a second bookkeeping path that could disagree with it.
 *
 * Returns after the set empties or the budget expires — never rejects, because a
 * drain that fails must not turn a graceful shutdown into a crash. What remains
 * is reported, so an operator can see the work that did not get to finish.
 */
export async function drainInFlightTasks(
  registry: { allInFlight?: () => unknown[] } | undefined,
  budgetMs: number,
  stderr: (s: string) => boolean,
): Promise<void> {
  const remaining = () => registry?.allInFlight?.()?.length ?? 0;
  const atStart = remaining();
  if (atStart === 0) return;
  if (budgetMs <= 0) {
    stderr(`[mma] ${atStart} task(s) still in flight; no drain budget configured, exiting now\n`);
    return;
  }
  stderr(`[mma] draining ${atStart} in-flight task(s), up to ${Math.round(budgetMs / 1000)}s\n`);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (remaining() === 0) {
      stderr('[mma] all in-flight tasks finished\n');
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(1, deadline - Date.now()))));
  }
  const left = remaining();
  if (left > 0) stderr(`[mma] drain budget elapsed with ${left} task(s) still running; exiting anyway\n`);
}

/**
 * Start the HTTP server with the given config.
 *
 * Registers SIGTERM and SIGINT handlers that drain in-flight requests and
 * exit the process cleanly: new dispatches are refused immediately, then the
 * server waits up to `server.limits.shutdownDrainMs` for what is already
 * running to finish. A second signal skips the remaining wait.
 *
 * @param config  Full MultiModelConfig (includes agents.*, defaults, diagnostics,
 *                and server block).  startServer() inspects the agents.* field
 *                and enables real tool handlers when present.
 * @param exit    Process exit function — defaults to process.exit.
 *                Exposed so tests can suppress actual exits.
 */
export async function startServe(
  config: MultiModelConfig,
  exit: (code: number) => never = process.exit.bind(process),
  configPath?: string,
): Promise<ServeHandle> {
  const stderr = process.stderr.write.bind(process.stderr);

  // Tiers are optional in the config SCHEMA so a machine can record a client
  // roster before it has chosen models — but a daemon without them can serve
  // nothing, so prove them here, once, before binding a port. Everything below
  // (and the ExecutionRuntime) then works with a config that provably has them.
  try {
    assertRunnable(config, configPath);
  } catch (err) {
    stderr(`[mma] ${err instanceof Error ? err.message : String(err)}\n`);
    return exit(1) as never;
  }

  // Auto-update installed skills before bind (bounded 5s; never blocks indefinitely).
  await maybeAutoUpdateSkills(config, stderr);

  // Drift check — warn if any declared client's provisioning is unhealthy.
  // Reads the SAME inventory GET /health does (provisioning/inventory.ts);
  // startServer() itself resolves any pending marker at boot before this
  // (and /health) would ever read it.
  try {
    const { buildProvisioningService } = await import('../provisioning/runtime-deps.js');
    const service = buildProvisioningService(config);
    const records = await service.inventory();
    const drift = records.filter((record) => record.status === 'failed');
    if (drift.length > 0) {
      const summary = drift.map((record) => `${record.clientId}=failed`).join(', ');
      stderr(`[mma] WARN: client provisioning drift detected: ${summary}. Re-run 'mma mcp install <client>' to reconcile.\n`);
    }
  } catch {
    // best-effort — never let drift check block serve
  }

  // Create the telemetry recorder BEFORE startServer. The server's bus
  // subscriber (TelemetryUploader) calls getRecorder() during startServer →
  // if recorder is null at that moment, the uploader is wired with
  // recorder=null and silently drops every event for the daemon's lifetime.
  const homeDir = path.join(os.homedir(), '.mma');
  const mmaVersion = SERVER_VERSION;
  createRecorder({ homeDir, mmaVersion });

  // Same directory executions.db lives in — both answer "what was this daemon
  // doing", so diagnosing means pointing at one place, and a test redirecting
  // stateDir moves both.
  const stateDir = expandHome(config.server.stateDir);

  // Pass the full MultiModelConfig (not just the server block) so
  // registerToolHandlers sees `agents` and registers real tool endpoints.
  // Stripping to { server } here caused a 3.1.0 regression where tool
  // endpoints returned 503 'no_agent_config' even when agents were set.
  let running: Awaited<ReturnType<typeof startServer>>;
  try {
    running = await startServer(config as Parameters<typeof startServer>[0], undefined, configPath);
  } catch (err) {
    // The most common startup failure by far is "a daemon is already running".
    // Until the listener raised PortInUseError this arrived as an uncaught
    // EADDRINUSE stack trace, which a backgrounded start swallowed entirely —
    // so the user saw nothing at all and believed the restart had worked.
    if (err instanceof PortInUseError) {
      const owner = readPidfile(stateDir);
      const who = owner && owner.port === err.port
        ? ` It is owned by an mma daemon (pid ${owner.pid}, version ${owner.version}).`
        : '';
      stderr(
        `[mma] cannot start: ${err.bind}:${err.port} is already in use.${who}\n` +
        `  Run 'mma restart' to replace it, or 'mma status' to see what it is doing.\n`,
      );
      return exit(1) as never;
    }
    throw err;
  }

  // ── stdout/stderr error + uncaught/unhandled rejection guards ────────
  const onStdoutError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') exit(0);
    try { process.stderr.write(`[mma] stdout error: ${err.message}\n`); } catch { /* stderr may also be dead */ }
    exit(1);
  };
  const onStderrError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') exit(0);
    exit(1);
  };
  const onUncaught = (err: unknown) => {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'EPIPE') exit(0);
    try {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[mma] uncaught exception: ${msg}\n`);
    } catch { /* best-effort */ }
    exit(1);
  };
  const onUnhandledRejection = (reason: unknown) => {
    const errno = (reason as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'EPIPE') exit(0);
    try {
      const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      process.stderr.write(`[mma] unhandled rejection: ${msg}\n`);
    } catch { /* best-effort */ }
    exit(1);
  };
  process.stdout.on('error', onStdoutError);
  process.stderr.on('error', onStderrError);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandledRejection);
  onStdoutErrorRef = onStdoutError;
  onStderrErrorRef = onStderrError;
  onUncaughtRef = onUncaught;
  onUnhandledRejectionRef = onUnhandledRejection;

  // Recorder was created above (BEFORE startServer). homeDir + mmaVersion
  // are computed there and reused here for the version-pin file + Flusher.
  const lastVersionPath = path.join(homeDir, 'last-version');
  let lastVersion: string | null = null;
  try {
    lastVersion = fs.readFileSync(lastVersionPath, 'utf8').trim();
  } catch {
    // first run — no last-version file yet
  }

  if (lastVersion !== mmaVersion) {
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(lastVersionPath, mmaVersion + '\n', { mode: 0o600 });
    } catch (err) {
      stderr(`[mma] warning: failed to write last-version at ${lastVersionPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Telemetry uploader. Default endpoint ships to the project's hosted
  // dashboard. MMA_TELEMETRY_ENDPOINT overrides for self-hosted backends;
  // setting it to an empty string disables shipping entirely (events stay in
  // ~/.mma/telemetry-queue.ndjson). The real off-switch for telemetry
  // is the consent flag (MMA_TELEMETRY=0 / config.telemetry.enabled =
  // false) — when consent is off the recorder enqueues nothing, so the
  // flusher's tick is a no-op even with the default endpoint set.
  const DEFAULT_TELEMETRY_ENDPOINT = 'https://mma-telemetry.x1.lucazhang.work/v1/events';
  const envEndpoint = process.env.MMA_TELEMETRY_ENDPOINT;
  const telemetryEndpoint = envEndpoint === undefined
    ? DEFAULT_TELEMETRY_ENDPOINT
    : envEndpoint.trim();
  let flusher: Flusher | null = null;
  if (telemetryEndpoint) {
    flusher = new Flusher({
      queue: new Queue(homeDir),
      dir: homeDir,
      endpoint: telemetryEndpoint,
    });
    flusher.start();
  }

  // Fire once at serve startup. Lives here (not in loadConfigFromFile) so
  // print-token / info / status don't re-emit the same warning repeatedly.
  const inlineOffenders = collectInlineApiKeyOffenders(config);
  if (inlineOffenders.length > 0) {
    const firstHint = envVarHint(inlineOffenders[0]!);
    stderr(
      `[mma] WARNING: inline apiKey in config for agent(s): ${inlineOffenders.join(', ')}.\n` +
      `  Fix:\n` +
      `    export ${firstHint}='<your-key>'\n` +
      `    # then in config.json, replace\n` +
      `    #   "apiKey": "..."\n` +
      `    # with\n` +
      `    #   "apiKeyEnv": "${firstHint}"\n`,
    );
  }

  const cleanupSignal = (sig: 'SIGTERM' | 'SIGINT') => {
    if (stopInFlight) {
      // A second signal means the operator is done waiting. Honour that rather
      // than making them sit out the remaining drain window.
      stderr(`[mma] received ${sig} again, exiting immediately\n`);
      exit(1);
      return;
    }
    stopInFlight = true;
    stderr(`[mma] received ${sig}, shutting down gracefully\u2026\n`);
    // 1) Refuse new dispatches immediately so they don't compound the drain.
    setDraining(true);
    // 2) Wait for in-flight tasks, bounded by server.limits.shutdownDrainMs.
    //    This used to be `Promise.resolve()` \u2014 the limit was declared in the
    //    config schema, defaulted to 30s, documented in this function's own
    //    docstring, and never read, so every shutdown killed in-flight work
    //    immediately while claiming to drain it.
    const drainSessions = drainInFlightTasks(
      running.executionRegistry,
      config.server.limits?.shutdownDrainMs ?? 0,
      stderr,
    );

    const drainTelemetry = flusher ? flusher.drain() : Promise.resolve();
    drainSessions
      .catch(() => { /* best-effort */ })
      .then(() => drainTelemetry)
      .catch(() => { /* drain is best-effort */ })
      .then(() => running.stop())
      // Remove the record only once the socket is closed. Removing it earlier
      // would make `mma stop` report no daemon while the port is still bound.
      .then(() => removePidfile(stateDir))
      .then(() => exit(0))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`[mma] shutdown failed: ${msg}\n`);
        exit(1);
      });
  };

  // Register handlers using named references so they can be removed correctly.
  // Using anonymous wrappers (e.g. `process.once('SIGTERM', () => fn(sig))`)
  // would make process.off(sig, fn) unable to find and remove the listener.
  onSigterm = () => cleanupSignal('SIGTERM');
  onSigint = () => cleanupSignal('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  // Print the actual bound address so operators see what the kernel assigned
  // (useful when port=0 selects an ephemeral port).
  const host = running.serverAddress ?? config.server.bind;

  // bootId discriminates successive startups that reuse a pid. Generated here
  // rather than inside the startup-line try block because the pidfile records
  // it too, and both must name the same boot.
  const bootId = randomUUID();

  // Record the daemon so `mma stop` / `mma restart` / `mma update` can find it
  // by fact rather than by matching a command-line pattern. Written after a
  // successful bind so the file never advertises a daemon that failed to start.
  writePidfile(stateDir, {
    pid: process.pid,
    port: running.port,
    bind: host,
    version: SERVER_VERSION,
    bootId,
    startedAt: Date.now(),
  });

  // Emit a single structured startup line before the "listening" line.
  // Fingerprint the auth token (first 8 hex of sha256) so operators can verify
  // the running instance matches what their clients are using, without ever
  // revealing the token.
  try {
    const token = loadAuthToken({ tokenFile: config.server.auth.tokenFile });
    const fp = createHash('sha256').update(token).digest('hex').slice(0, 8);
    const version = SERVER_VERSION;
    process.stdout.write(
      `[mma] started | version=${version} | bind=${host}:${running.port} | pid=${process.pid} | token=${fp} | boot=${bootId}\n`,
    );
  } catch {
    // Token load shouldn't fail here (startServer already validated it), but
    // if it does, skip the startup line rather than crash the server.
  }

  // Per-tier model lines so operators can see which provider is wired to
  // each agent slot. The complex tier handles read-only sub-workers + most
  // implementer work; the standard tier handles annotator/reviewer + the
  // explore route's internal half. When a tier is unconfigured, log it as
  // "(not configured)" so a misconfigured slot is visible at boot time.
  const fmtTier = (slot: string): string => {
    const cfg = (config.agents as Record<string, { type?: string; model?: string }>)[slot];
    if (!cfg || !cfg.model) return '(not configured)';
    return `${cfg.model} [${cfg.type ?? 'unknown'}]`;
  };
  const mainLabel = config.agents.main ? ` | main=${fmtTier('main')}` : '';
  process.stdout.write(`[mma] tiers | complex=${fmtTier('complex')} | standard=${fmtTier('standard')}${mainLabel}\n`);

  // A4a.4 (4.2.2+): warn when stale Claude Code project siblings exist
  // under /tmp/claude/G--*. These come from prior Claude Code test runs
  // and confuse worker cwd resolution if a caller passes one as ?cwd=.
  // The validator already rejects them at request time (A4a.1); this
  // startup scan surfaces the contamination so operators clean it up.
  // Pure log behavior — does NOT block startup.
  for (const root of ['/tmp/claude', '/private/tmp/claude']) {
    try {
      if (!fs.existsSync(root)) continue;
      const stale = fs.readdirSync(root).filter(e => e.startsWith('G--'));
      if (stale.length > 0) {
        process.stdout.write(
          `[mma] WARNING: ${stale.length} stale Claude Code project sibling(s) under ${root}/G--*. ` +
          `These can confuse cwd resolution; clean up with: rm -rf ${root}/G--*\n`
        );
      }
    } catch { /* swallow — log-only */ }
  }

  process.stdout.write(`[mma] listening on ${host}:${running.port}\n`);

  return {
    port: running.port,
    stop: async () => {
      // Clean up signal listeners to prevent leaks when stop() is called
      // programmatically (i.e. not via a signal).
      if (onSigterm) process.off('SIGTERM', onSigterm);
      if (onSigint) process.off('SIGINT', onSigint);
      if (onStdoutErrorRef) process.stdout.off('error', onStdoutErrorRef);
      if (onStderrErrorRef) process.stderr.off('error', onStderrErrorRef);
      if (onUncaughtRef) process.off('uncaughtException', onUncaughtRef);
      if (onUnhandledRejectionRef) process.off('unhandledRejection', onUnhandledRejectionRef);
      onStdoutErrorRef = onStderrErrorRef = onUncaughtRef = onUnhandledRejectionRef = undefined;
      if (flusher) {
        await flusher.drain().catch(() => { /* best-effort */ });
      }
      await running.stop();
      removePidfile(stateDir);
    },
  };
}
