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
 *   mmagent serve [--config <path>]
 *   // this module owns signal handling and process.exit
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { collectInlineApiKeyOffenders, loadAuthToken } from '@zhixuan92/multi-model-agent-core';
import { startServer } from '../http/server.js';
import { createRecorder } from '../telemetry/recorder.js';
import { Flusher } from '../telemetry/flusher.js';
import { Queue } from '../telemetry/queue.js';
import { runUpdateSkills } from './update-skills.js';
import { listEntries, FutureManifestError } from '../install/manifest.js';
import { readSkillContent } from './install-skill.js';
import matter from 'gray-matter';

function isSkillBehind(entryName: string, entrySkillVersion: string): boolean {
  const src = readSkillContent(entryName);
  if (src === null) return false; // missing; update-skills handles removal separately
  try {
    const parsed = matter(src);
    const v = parsed.data['version'];
    return typeof v === 'string' && v !== entrySkillVersion;
  } catch {
    return false;
  }
}

async function maybeAutoUpdateSkills(
  config: MultiModelConfig,
  stderr: (s: string) => boolean,
): Promise<void> {
  let entries;
  try {
    entries = listEntries();
  } catch (err) {
    if (err instanceof FutureManifestError) {
      stderr(`[mmagent] warning: ${err.message}; skipping skill auto-update\n`);
      return;
    }
    return; // best-effort — never let manifest IO issues block serve
  }

  const behind = entries.filter((e) => isSkillBehind(e.name, e.skillVersion));
  if (behind.length === 0) return;

  if (!config.server.autoUpdateSkills) {
    stderr(
      `[mmagent] ${behind.length} skill(s) out of date: ${behind.map((e) => e.name).join(', ')}. ` +
      `Run 'mmagent update-skills' to refresh (or set server.autoUpdateSkills=true in config).\n`,
    );
    return;
  }

  const deadlineMs = 5000;
  try {
    await Promise.race([
      runUpdateSkills({ silent: true, bestEffort: true }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), deadlineMs)),
    ]);
    process.stdout.write(`[mmagent] auto-updated ${behind.length} skill(s)\n`);
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

function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (Number.isNaN(aMaj) || Number.isNaN(aMin) || Number.isNaN(aPat) ||
      Number.isNaN(bMaj) || Number.isNaN(bMin) || Number.isNaN(bPat)) {
    return -1; // unparseable version → treat as mismatched
  }
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
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
): Promise<ServeHandle> {
  const stderr = process.stderr.write.bind(process.stderr);

  // Auto-update installed skills before bind (bounded 5s; never blocks indefinitely).
  await maybeAutoUpdateSkills(config, stderr);

  // Pass the full MultiModelConfig (not just the server block) so
  // registerToolHandlers sees `agents` and registers real tool endpoints.
  // Stripping to { server } here caused a 3.1.0 regression where tool
  // endpoints returned 503 'no_agent_config' even when agents were set.
  const running = await startServer(config as Parameters<typeof startServer>[0]);

  // ── Telemetry: consent re-confirmation + recorder ─────────────────────
  const homeDir = path.join(os.homedir(), '.multi-model');
  const mmagentVersion = readServerVersion();

  // V2→V3 consent re-confirmation (§7.6): V2 opt-ins do NOT auto-migrate.
  // When telemetry is enabled but consent schemaVersion is < 3,
  // clear the flag and prompt the user to re-confirm.
  const configPath = path.join(homeDir, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const telemetry = (cfg.telemetry ?? {}) as Record<string, unknown>;
    if (telemetry.enabled === true) {
      const consentVersion = (telemetry as any).consentSchemaVersion as number | undefined;
      if ((consentVersion ?? 0) < 3) {
        telemetry.enabled = false;
        (telemetry as any).consentSchemaVersion = 3;
        cfg.telemetry = telemetry;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
        stderr('mmagent: telemetry schema upgraded to v3; previous opt-in cleared.\n');
        stderr('Run "mmagent telemetry enable" to opt in to schema v3.\n');
      }
    }
  } catch {
    // no config file, first run — nothing to migrate
  }

  const recorder = createRecorder({ homeDir, mmagentVersion });

  const lastVersionPath = path.join(homeDir, 'last-version');
  let lastVersion: string | null = null;
  try {
    lastVersion = fs.readFileSync(lastVersionPath, 'utf8').trim();
  } catch {
    // first run — no last-version file yet
  }

  if (lastVersion !== mmagentVersion) {
    const trigger: 'fresh_install' | 'upgrade' | 'downgrade' =
      lastVersion === null
        ? 'fresh_install'
        : compareSemver(lastVersion, mmagentVersion) < 0
          ? 'upgrade'
          : 'downgrade';
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(lastVersionPath, mmagentVersion + '\n', { mode: 0o600 });
    } catch (err) {
      stderr(`[mmagent] warning: failed to write last-version at ${lastVersionPath}: ${err instanceof Error ? err.message : String(err)}\n`);
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
      `[mmagent] WARNING: inline apiKey in config for agent(s): ${inlineOffenders.join(', ')}.\n` +
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
    stderr(`[mmagent] received ${sig}, shutting down gracefully\u2026\n`);
    const drainTelemetry = flusher ? flusher.drain() : Promise.resolve();
    drainTelemetry
      .catch(() => { /* drain is best-effort */ })
      .then(() => running.stop())
      .then(() => exit(0))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`[mmagent] shutdown failed: ${msg}\n`);
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
      `[mmagent] started | version=${version} | bind=${host}:${running.port} | pid=${process.pid} | token=${fp} | boot=${bootId}\n`,
    );
  } catch {
    // Token load shouldn't fail here (startServer already validated it), but
    // if it does, skip the startup line rather than crash the server.
  }

  process.stdout.write(`[mmagent] listening on ${host}:${running.port}\n`);

  return {
    port: running.port,
    stop: async () => {
      // Clean up signal listeners to prevent leaks when stop() is called
      // programmatically (i.e. not via a signal).
      if (onSigterm) process.off('SIGTERM', onSigterm);
      if (onSigint) process.off('SIGINT', onSigint);
      if (flusher) {
        await flusher.drain().catch(() => { /* best-effort */ });
      }
      await running.stop();
    },
  };
}