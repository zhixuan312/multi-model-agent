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
import { fileURLToPath } from 'node:url';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
// ShutdownCause: previously exported from http-server-log.ts (removed in events refactor).
type ShutdownCause = 'sigterm' | 'sigint' | 'uncaught_exception' | 'unhandled_rejection' | 'stdout_epipe' | 'stdout_other_error' | 'uncaughtException' | 'unhandledRejection';
import { collectInlineApiKeyOffenders, loadAuthToken } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '../http/server.js';
import { setDraining } from '../http/request-pipeline.js';
import { createRecorder } from '../telemetry/recorder.js';
import { Flusher } from '../telemetry/flusher.js';
import { Queue } from '../telemetry/queue.js';
import { runSyncSkills } from './sync-skills.js';
import { listEntries, FutureManifestError } from '../skill-install/manifest.js';
import { readSkillContent, SUPPORTED_SKILLS } from '../skill-install/discover.js';
import { findMissingSkills } from '../skill-install/skill-installer-common.js';
import matter from 'gray-matter';

function isSkillBehind(entryName: string, entrySkillVersion: string): boolean {
  const src = readSkillContent(entryName);
  if (src === null) return false; // skill removed from bundle — sync-skills will drop it
  try {
    const parsed = matter(src);
    const v = parsed.data['version'];
    return typeof v === 'string' && v !== entrySkillVersion;
  } catch {
    return false;
  }
}

export async function maybeAutoUpdateSkills(
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
  if (behind.length === 0 && missing.length === 0) return;

  if (!config.server.autoUpdateSkills) {
    const drift: string[] = [];
    if (behind.length > 0) drift.push(`${behind.length} out of date (${behind.map((e) => e.name).join(', ')})`);
    if (missing.length > 0) drift.push(`${missing.length} new (${missing.map((m) => m.name).join(', ')})`);
    stderr(
      `[mma] skill drift: ${drift.join('; ')}. ` +
      `Run 'mma sync-skills' to reconcile (or set server.autoUpdateSkills=true in config).\n`,
    );
    return;
  }

  const deadlineMs = 5000;
  try {
    await Promise.race([
      runSyncSkills({ silent: true, bestEffort: true, ifExists: true }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), deadlineMs)),
    ]);
    if (behind.length > 0) process.stdout.write(`[mma] auto-synced ${behind.length} updated skill(s)\n`);
    if (missing.length > 0) process.stdout.write(`[mma] auto-synced ${missing.length} new skill(s): ${missing.map((m) => m.name).join(', ')}\n`);
  } catch {
    // bestEffort swallows inside; extra safety here.
  }
}

function readServerVersion(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(thisDir, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function envVarHint(agentName: string): string {
  return `${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** A running server handle returned by startServe(). */
export interface ServeHandle {
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
 * Start the HTTP server with the given config.
 *
 * Registers SIGTERM and SIGINT handlers that drain in-flight requests and
 * exit the process cleanly. If config includes `server.limits.shutdownDrainMs`,
 * the server will wait up to that duration for in-flight requests to finish.
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

  // Auto-update installed skills before bind (bounded 5s; never blocks indefinitely).
  await maybeAutoUpdateSkills(config, stderr);

  // Drift check — warn if installed skills don't match the canonical manifest.
  try {
    const { makeSkillManifestSync } = await import('../skill-install/skill-manifest-sync.js');
    const { discoverPerClientInstallDirs } = await import('../skill-install/discover.js');
    const sync = makeSkillManifestSync(discoverPerClientInstallDirs());
    const drift = sync.driftReport();
    if (drift.length > 0) {
      const summary = drift.map(d => `${d.client}/${d.skill}=${d.issue}`).join(', ');
      stderr(`[mma] WARN: skill manifest drift detected: ${summary}. Re-run 'mma sync-skills' to reconcile.\n`);
    }
  } catch {
    // best-effort — never let drift check block serve
  }

  // Create the telemetry recorder BEFORE startServer. The server's bus
  // subscriber (TelemetryUploader) calls getRecorder() during startServer →
  // if recorder is null at that moment, the uploader is wired with
  // recorder=null and silently drops every event for the daemon's lifetime.
  const homeDir = path.join(os.homedir(), '.multi-model');
  const mmagentVersion = readServerVersion();
  createRecorder({ homeDir, mmagentVersion });

  // Pass the full MultiModelConfig (not just the server block) so
  // registerToolHandlers sees `agents` and registers real tool endpoints.
  // Stripping to { server } here caused a 3.1.0 regression where tool
  // endpoints returned 503 'no_agent_config' even when agents were set.
  const running = await startServer(config as Parameters<typeof startServer>[0], undefined, configPath);

  // ── stdout/stderr error + uncaught/unhandled rejection guards ────────
  const logShutdown = (_cause: ShutdownCause): void => {
    // Option A: no diagnostics surface today. Cause name routed via stderr only.
    // Option B (follow-up): wire running.diagnostics?.shutdown(_cause) here.
  };

  const onStdoutError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') { logShutdown('stdout_epipe'); exit(0); }
    logShutdown('stdout_other_error');
    try { process.stderr.write(`[mma] stdout error: ${err.message}\n`); } catch { /* stderr may also be dead */ }
    exit(1);
  };
  const onStderrError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') { logShutdown('stdout_epipe'); exit(0); }
    logShutdown('stdout_other_error');
    exit(1);
  };
  const onUncaught = (err: unknown) => {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'EPIPE') { logShutdown('stdout_epipe'); exit(0); }
    logShutdown('uncaughtException');
    try {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[mma] uncaught exception: ${msg}\n`);
    } catch { /* best-effort */ }
    exit(1);
  };
  const onUnhandledRejection = (reason: unknown) => {
    const errno = (reason as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'EPIPE') { logShutdown('stdout_epipe'); exit(0); }
    logShutdown('unhandledRejection');
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

  // Recorder was created above (BEFORE startServer). homeDir + mmagentVersion
  // are computed there and reused here for the version-pin file + Flusher.
  const lastVersionPath = path.join(homeDir, 'last-version');
  let lastVersion: string | null = null;
  try {
    lastVersion = fs.readFileSync(lastVersionPath, 'utf8').trim();
  } catch {
    // first run — no last-version file yet
  }

  if (lastVersion !== mmagentVersion) {
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(lastVersionPath, mmagentVersion + '\n', { mode: 0o600 });
    } catch (err) {
      stderr(`[mma] warning: failed to write last-version at ${lastVersionPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Telemetry uploader. Default endpoint ships to the project's hosted
  // dashboard. MMAGENT_TELEMETRY_ENDPOINT overrides for self-hosted backends;
  // setting it to an empty string disables shipping entirely (events stay in
  // ~/.multi-model/telemetry-queue.ndjson). The real off-switch for telemetry
  // is the consent flag (MMAGENT_TELEMETRY=0 / config.telemetry.enabled =
  // false) — when consent is off the recorder enqueues nothing, so the
  // flusher's tick is a no-op even with the default endpoint set.
  const DEFAULT_TELEMETRY_ENDPOINT = 'https://mma-telemetry-frontend.x1.lucazhang.work/v1/events';
  const envEndpoint = process.env.MMAGENT_TELEMETRY_ENDPOINT;
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
    if (stopInFlight) return;
    stopInFlight = true;
    stderr(`[mma] received ${sig}, shutting down gracefully\u2026\n`);
    // 1) Refuse new dispatches immediately so they don't compound the drain.
    setDraining(true);
    // 2) TaskRegistry tracks in-flight tasks (no execution contexts).
    //    Log what's still running for operators, then proceed to shutdown.
    const inflight = running.taskRegistry?.allInFlight?.() ?? [];
    if (inflight.length > 0) {
      stderr(`[mma] draining ${inflight.length} in-flight task(s)\n`);
    }
    const drainSessions = Promise.resolve();

    const drainTelemetry = flusher ? flusher.drain() : Promise.resolve();
    drainSessions
      .catch(() => { /* best-effort */ })
      .then(() => drainTelemetry)
      .catch(() => { /* drain is best-effort */ })
      .then(() => running.stop())
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

  // Emit a single structured startup line before the "listening" line.
  // Fingerprint the auth token (first 8 hex of sha256) so operators can verify
  // the running instance matches what their clients are using, without ever
  // revealing the token. bootId discriminates successive startups from the same pid.
  try {
    const token = loadAuthToken({ tokenFile: config.server.auth.tokenFile });
    const fp = createHash('sha256').update(token).digest('hex').slice(0, 8);
    const bootId = randomUUID();
    const version = readServerVersion();
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
    },
  };
}
