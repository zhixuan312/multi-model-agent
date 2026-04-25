/**
 * telemetry.ts — `mmagent telemetry` subcommands.
 *
 * Usage:
 *   mmagent telemetry status
 *   mmagent telemetry enable
 *   mmagent telemetry disable
 *   mmagent telemetry reset-id
 *   mmagent telemetry dump-queue
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decide } from '../telemetry/consent.js';
import { deleteInstallId, hasInstallId, getOrCreateInstallId } from '../telemetry/install-id.js';
import { readGeneration, bumpGeneration } from '../telemetry/generation.js';
import { Queue } from '../telemetry/queue.js';

export interface TelemetryDeps {
  subcommand: 'status' | 'enable' | 'disable' | 'reset-id' | 'dump-queue';
  homeDir: string;
  /** Write to stdout. */
  stdout?: (s: string) => boolean;
  /** Write to stderr. */
  stderr?: (s: string) => boolean;
}

/**
 * Read the raw MMAGENT_TELEMETRY env value (not the parsed decision).
 */
function readRawEnv(): string | undefined {
  return process.env.MMAGENT_TELEMETRY;
}

/**
 * Read the existing config.json as a parsed object, or null if it doesn't exist.
 */
function readConfigObj(homeDir: string): Record<string, unknown> | null {
  const cfgPath = join(homeDir, 'config.json');
  if (!existsSync(cfgPath)) return null;
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write config.json, ensuring parent directory exists.
 */
function writeConfigObj(homeDir: string, obj: Record<string, unknown>): void {
  const cfgPath = join(homeDir, 'config.json');
  const parent = dirname(cfgPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

async function revokeIdentity(homeDir: string): Promise<void> {
  await bumpGeneration(homeDir);
  const queuePath = join(homeDir, 'telemetry-queue.ndjson');
  if (existsSync(queuePath)) unlinkSync(queuePath);
}

// ─── status ──────────────────────────────────────────────────────────────────

async function runStatus(deps: TelemetryDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const d = decide(deps.homeDir);
  const envRaw = readRawEnv();

  const lines: string[] = [];
  lines.push(`Telemetry: ${d.enabled ? 'enabled' : 'disabled'}`);
  lines.push(`Source:    ${d.source}`);

  if (d.source === 'env_invalid') {
    lines.push(`Warning:   MMAGENT_TELEMETRY="${envRaw ?? ''}" is not a recognized value (use 1/true/on/yes or 0/false/off/no)`);
  }

  // Surface set-but-empty env distinction
  if (envRaw !== undefined && envRaw.trim().length === 0) {
    lines.push(`Note:      MMAGENT_TELEMETRY is set to '' (no effect — falls through to ${d.source})`);
  }

  stdout(lines.join('\n') + '\n');
  return 0;
}

// ─── enable ──────────────────────────────────────────────────────────────────

async function runEnable(deps: TelemetryDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  let cfg = readConfigObj(deps.homeDir) ?? {};

  // Remove bare top-level `enabled` if present — canonical shape is `telemetry.enabled`
  if (typeof cfg.enabled === 'boolean') {
    delete cfg.enabled;
  }

  const telemetry = (cfg.telemetry ?? {}) as Record<string, unknown>;
  telemetry.enabled = true;
  cfg.telemetry = telemetry;

  try {
    writeConfigObj(deps.homeDir, cfg);
    stdout('Telemetry enabled (config.telemetry.enabled = true)\n');
    return 0;
  } catch (err) {
    stderr(`mmagent telemetry enable: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ─── disable ──────────────────────────────────────────────────────────────────

async function runDisable(deps: TelemetryDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  let cfg = readConfigObj(deps.homeDir) ?? {};

  if (typeof cfg.enabled === 'boolean') {
    delete cfg.enabled;
  }

  const telemetry = (cfg.telemetry ?? {}) as Record<string, unknown>;
  telemetry.enabled = false;
  cfg.telemetry = telemetry;

  try {
    writeConfigObj(deps.homeDir, cfg);
    await revokeIdentity(deps.homeDir);
    stdout('Telemetry disabled (config.telemetry.enabled = false, identity revoked)\n');
    return 0;
  } catch (err) {
    stderr(`mmagent telemetry disable: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ─── reset-id ─────────────────────────────────────────────────────────────────

async function runResetId(deps: TelemetryDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  try {
    await revokeIdentity(deps.homeDir);
    deleteInstallId(deps.homeDir);
    stdout('Identity reset (generation bumped, queue deleted, install-id deleted)\n');
    return 0;
  } catch (err) {
    stderr(`mmagent telemetry reset-id: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ─── dump-queue ───────────────────────────────────────────────────────────────

async function runDumpQueue(deps: TelemetryDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  try {
    const queue = new Queue(deps.homeDir);
    const batch = await queue.readBatch();
    stdout(JSON.stringify(batch.records, null, 2) + '\n');
    return 0;
  } catch (err) {
    stderr(`mmagent telemetry dump-queue: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

export async function runTelemetry(deps: TelemetryDeps): Promise<number> {
  switch (deps.subcommand) {
    case 'status':    return runStatus(deps);
    case 'enable':    return runEnable(deps);
    case 'disable':   return runDisable(deps);
    case 'reset-id':  return runResetId(deps);
    case 'dump-queue':return runDumpQueue(deps);
    default: {
      const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
      stderr(`mmagent telemetry: unknown subcommand '${(deps as any).subcommand}'\n`);
      return 1;
    }
  }
}
