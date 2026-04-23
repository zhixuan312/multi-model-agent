/**
 * `mmagent install-skill` CLI command.
 *
 * Syntax:
 *   mmagent install-skill [--uninstall] [--dry-run] [--json] [--target=claude-code|gemini|codex|cursor]
 *                        [--all-targets] [skill-name]
 *
 * Config discovery order:
 *   1. --config <path>
 *   2. $MMAGENT_CONFIG env var
 *   3. CWD/.multi-model-agent.json
 *   4. ~/.multi-model/config.json
 *
 * Skills are sourced from packages/server/src/skills/<skill-name>/SKILL.md.
 * install-skill copies the SKILL.md to the appropriate per-client location
 * and records the installation in the manifest (~/.multi-model/install-manifest.json).
 *
 * Task 9.4 scope: CLI scaffolding, manifest read/append-entry/remove-entry,
 * auto-detection scaffolding, dry-run mode.
 * Individual client writers are implemented in tasks 9.5–9.8.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import minimist from 'minimist';
import * as manifest from '../install/manifest.js';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core';

/** Resolved path to the bundled skills directory. Can be overridden for testing. */
const DEFAULT_SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
);

export const SUPPORTED_SKILLS = [
  'multi-model-agent',
  'mma-delegate',
  'mma-audit',
  'mma-review',
  'mma-verify',
  'mma-debug',
  'mma-execute-plan',
  'mma-retry',
  'mma-context-blocks',
  'mma-clarifications',
] as const;

export type Client = 'claude-code' | 'gemini' | 'codex' | 'cursor';

export const ALL_CLIENTS: readonly Client[] = ['claude-code', 'gemini', 'codex', 'cursor'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return the absolute path to the skills root directory.
 *
 * The skills root is the directory containing per-skill sub-directories
 * (e.g. `<root>/mma-delegate/SKILL.md`).  In production this resolves to
 * `packages/server/src/skills/`.  During tests the caller can pass a custom
 * `skillsRoot` to read from a temp fixture instead.
 */
export function getSkillsRoot(skillsRoot?: string): string {
  return skillsRoot ?? DEFAULT_SKILLS_ROOT;
}

export function readSkillContent(skillName: string, skillsRoot?: string): string | null {
  const skillFile = path.join(getSkillsRoot(skillsRoot), skillName, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  return fs.readFileSync(skillFile, 'utf-8');
}

/**
 * Detect which AI client directories exist in the home directory.
 * Returns the list of detected Client values.
 */
export function detectClients(homeDir: string): Client[] {
  const detected: Client[] = [];
  if (fs.existsSync(path.join(homeDir, '.claude', 'skills'))) detected.push('claude-code');
  if (fs.existsSync(path.join(homeDir, '.gemini', 'extensions'))) detected.push('gemini');
  if (fs.existsSync(path.join(homeDir, '.codex', 'AGENTS.md'))) detected.push('codex');
  if (fs.existsSync(path.join(homeDir, '.cursor', 'rules'))) detected.push('cursor');
  return detected;
}

// ─── Per-client writer/remover skeletons ──────────────────────────────────────
// These are scaffolding for tasks 9.5–9.8. Each writer/remover is currently
// a no-op stub; the stub is replaced by the actual implementation per task.

/**
 * Write a skill's SKILL.md content to the target client's skill directory.
 * STUB — implemented in tasks 9.5–9.8.
 */
export function writeSkillToClient(
  _skillName: string,
  _content: string,
  _target: Client,
  _homeDir: string,
): void {
  // TODO(tasks 9.5–9.8): implement per-client writer
  throw new Error('install-skill: client writers are not yet implemented');
}

/**
 * Remove a skill's files from the target client's skill directory.
 * STUB — implemented in task 9.9.
 */
export function removeSkillFromClient(_skillName: string, _target: Client, _homeDir: string): void {
  // TODO(task 9.9): implement per-client remover
  throw new Error('install-skill: client removers are not yet implemented');
}

// ─── Config discovery ───────────────────────────────────────────────────────

export interface DiscoveredConfig {
  /** Absolute path from which the config was loaded. */
  path: string;
}

/**
 * Discover the agent configuration using the standard CLI discovery order:
 *   1. --config <path>              (CLI argument, highest priority)
 *   2. $MMAGENT_CONFIG env var      (environment variable)
 *   3. CWD/.multi-model-agent.json  (current working directory)
 *   4. ~/.multi-model/config.json   (per-user default)
 *
 * Returns the first config found that contains at least one agent definition.
 * Throws if a config file exists but is invalid.
 * Returns null if no config file is found.
 *
 * @param explicitPath  Path from --config argument; undefined if not provided.
 */
export async function discoverConfig(explicitPath?: string): Promise<DiscoveredConfig | null> {
  type Candidate =
    | { kind: 'cli'; path: string }
    | { kind: 'env'; path: string }
    | { kind: 'cwd'; path: string }
    | { kind: 'home'; path: string };

  const candidates: Candidate[] = [
    ...(explicitPath ? [{ kind: 'cli' as const, path: explicitPath }] : []),
    ...(process.env.MMAGENT_CONFIG
      ? [{ kind: 'env' as const, path: process.env.MMAGENT_CONFIG }]
      : []),
    { kind: 'cwd', path: path.join(process.cwd(), '.multi-model-agent.json') },
    { kind: 'home', path: path.join(os.homedir(), '.multi-model', 'config.json') },
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    try {
      const cfg = await loadConfigFromFile(candidate.path);
      if (cfg && cfg.agents && Object.keys(cfg.agents).length > 0) {
        return { path: candidate.path };
      }
    } catch {
      throw new Error(`Config file '${candidate.path}' exists but could not be parsed`);
    }
  }

  return null;
}

// ─── Install/Uninstall result ───────────────────────────────────────────────

export interface InstallResult {
  skill: string;
  action: 'installed' | 'uninstalled';
  targets: Client[];
  /** Targets that were skipped (dry-run, unknown, or not applicable). */
  skipped: Client[];
  /** Files would be written but were not (dry-run mode). */
  dryRun: boolean;
}

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Install a skill to the specified client targets.
 * - dryRun=true: resolves targets and checks skill existence; does NOT write files or update manifest.
 * - dryRun=false: writes files and updates manifest (requires client writers from tasks 9.5+).
 *
 * @param skillsRoot  Optional override for the skills root path (used by tests to point at temp fixtures).
 */
export function doInstall(
  skillName: string,
  targets: Client[],
  opts: { dryRun: boolean; json: boolean; homeDir: string; skillsRoot?: string },
): InstallResult {
  const content = readSkillContent(skillName, opts.skillsRoot);
  if (!content) {
    throw new Error(
      `Skill '${skillName}' not found. ` +
      `Checked: ${path.join(getSkillsRoot(opts.skillsRoot), skillName, 'SKILL.md')}. ` +
      `Available skills: ${SUPPORTED_SKILLS.join(', ')}`,
    );
  }

  const installed: Client[] = [];
  const skipped: Client[] = [];

  for (const target of targets) {
    if (opts.dryRun) {
      // In dry-run: record target as skipped (would write), not installed
      skipped.push(target);
    } else {
      // Non-dry-run: write to disk and update manifest
      // Client writers (tasks 9.5–9.8) replace the stub below:
      writeSkillToClient(skillName, content, target, opts.homeDir);
      installed.push(target);
    }
  }

  return { skill: skillName, action: 'installed', targets: installed, skipped, dryRun: opts.dryRun };
}

/**
 * Uninstall a skill from the specified client targets.
 * - dryRun=true: resolves targets; does NOT remove files or update manifest.
 * - dryRun=false: removes files and updates manifest (requires client removers from task 9.9).
 */
export function doUninstall(
  skillName: string,
  targets: Client[],
  opts: { dryRun: boolean; json: boolean; homeDir: string },
): InstallResult {
  const installed: Client[] = [];
  const skipped: Client[] = [];

  for (const target of targets) {
    if (opts.dryRun) {
      skipped.push(target);
    } else {
      // Client removers (task 9.9) replace the stub below:
      removeSkillFromClient(skillName, target, opts.homeDir);
      installed.push(target);
    }
  }

  return { skill: skillName, action: 'uninstalled', targets: installed, skipped, dryRun: opts.dryRun };
}

// ─── argv parsing ───────────────────────────────────────────────────────────

export interface ParsedArgs {
  skill: string | null;
  uninstall: boolean;
  dryRun: boolean;
  json: boolean;
  targets: Client[] | null;
  allTargets: boolean;
  configPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = minimist(argv, {
    string: ['target', 'skill', 'config'],
    boolean: ['uninstall', 'dry-run', 'json', 'all-targets'],
    alias: {
      u: 'uninstall',
      j: 'json',
      t: 'target',
      c: 'config',
    },
    stopEarly: true,
  });

  const skill = (args._[0] as string | undefined) ?? null;
  const uninstall = args['uninstall'] === true;
  const dryRun = args['dry-run'] === true;
  const json = args['json'] === true;
  const allTargets = args['all-targets'] === true;
  const configPath = (args['config'] as string | undefined) ?? null;

  let targets: Client[] | null = null;
  if (args.target) {
    const t = Array.isArray(args.target) ? args.target : [args.target];
    targets = (t as string[]).map((s) => s as Client);
  }

  return { skill, uninstall, dryRun, json, targets, allTargets, configPath };
}

/**
 * Resolve the target client list.
 * Priority:
 *   1. explicit `--target` arguments (validated against known clients)
 *   2. `--all-targets` → all four known clients
 *   3. auto-detect based on `homeDir`
 */
export function resolveTargets(
  explicitTargets: Client[] | null,
  allTargets: boolean,
  homeDir: string,
): Client[] {
  if (allTargets) return [...ALL_CLIENTS];

  if (explicitTargets !== null) {
    for (const t of explicitTargets) {
      if (!ALL_CLIENTS.includes(t)) {
        throw new Error(`Unknown target: ${t}. Valid: ${ALL_CLIENTS.join(', ')}`);
      }
    }
    return explicitTargets;
  }

  return detectClients(homeDir);
}

// ─── Output helpers ─────────────────────────────────────────────────────────

function printResult(result: InstallResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    const verb = result.action === 'installed' ? 'Installed' : 'Uninstalled';
    const targetStr = result.targets.length > 0 ? ` → ${result.targets.join(', ')}` : '';
    const skippedStr = result.skipped.length > 0 ? ` (dry-run: ${result.skipped.join(', ')})` : '';
    console.log(`${verb} '${result.skill}'${targetStr}${skippedStr}`);
  }
}

// ─── argv entry point ───────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { skill, uninstall, dryRun, json, targets: explicitTargets, allTargets, configPath } =
    parseArgs(argv);

  if (!skill) {
    console.error(
      'Usage: mmagent install-skill [--uninstall] [--dry-run] [--json] [--target=<client>] [--all-targets] [--config=<path>] <skill-name>',
    );
    console.error('Skills: ' + SUPPORTED_SKILLS.join(', '));
    process.exit(1);
  }

  if (!SUPPORTED_SKILLS.includes(skill as (typeof SUPPORTED_SKILLS)[number])) {
    console.error(`Unknown skill '${skill}'. Available: ${SUPPORTED_SKILLS.join(', ')}`);
    process.exit(1);
  }

  const homeDir = os.homedir();
  const resolvedTargets = resolveTargets(explicitTargets, allTargets, homeDir);

  if (resolvedTargets.length === 0) {
    if (json) {
      console.log(
        JSON.stringify({ skill, action: uninstall ? 'uninstalled' : 'installed', targets: [], skipped: [] }),
      );
    } else {
      console.log('No clients detected. Use --target or --all-targets to specify targets.');
    }
    return;
  }

  const opts = { dryRun, json, homeDir };

  const result = uninstall
    ? doUninstall(skill, resolvedTargets, opts)
    : doInstall(skill, resolvedTargets, opts);

  printResult(result, json);

  if (!dryRun) {
    if (uninstall) {
      const removed = manifest.removeEntry(skill, resolvedTargets, homeDir);
      if (!json && removed.length > 0) {
        console.log(`Removed manifest entry for ${removed.join(', ')}.`);
      }
    } else {
      manifest.appendEntry(skill, '1.0.0', resolvedTargets, homeDir);
      if (!json) {
        console.log('Manifest updated.');
      }
    }
  }

  // Config discovery result is informational; it does not gate the operation.
  // Run it here so the CLI exercises the discovery path during smoke testing.
  if (configPath || process.env.MMAGENT_CONFIG || true) {
    try {
      const discovered = await discoverConfig(configPath ?? undefined);
      // Silently absorb; we surface errors only when a config was explicitly requested
      // but could not be loaded (handled inside discoverConfig).
    } catch (_e) {
      // Only fail on explicit --config that is malformed; auto-discovery failures are fine.
      if (configPath) {
        console.error((_e as Error).message);
        process.exit(1);
      }
    }
  }
}

// Only run when executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
