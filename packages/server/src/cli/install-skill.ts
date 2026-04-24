/**
 * `mmagent install-skill` CLI command.
 *
 * Syntax:
 *   mmagent install-skill [--uninstall] [--dry-run] [--json]
 *                        [--target=claude-code|gemini|codex|cursor]
 *                        [--all-targets] [skill-name]
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
import type { Client } from '../install/manifest.js';
import { ALL_CLIENTS, detectClients } from '../install/manifest.js';

// Re-export Client and constants so CLI callers can import from this module.
export type { Client } from '../install/manifest.js';
export { ALL_CLIENTS, detectClients } from '../install/manifest.js';

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

// ─── Custom errors ────────────────────────────────────────────────────────────

/** Thrown when a passed `--target` value is not a known client. */
export class UnknownTargetError extends Error {
  readonly code = 'unknown_target' as const;
  constructor(target: string, valid: readonly Client[]) {
    super(`Unknown target: ${target}. Valid: ${valid.join(', ')}`);
  }
}

/** Thrown when a skill's SKILL.md cannot be read from the bundled skills directory. */
export class SkillNotFoundError extends Error {
  readonly code = 'skill_not_found' as const;
  constructor(skillName: string, checkedPath: string) {
    super(
      `Skill '${skillName}' not found. ` +
      `Checked: ${checkedPath}. ` +
      `Available skills: ${SUPPORTED_SKILLS.join(', ')}`,
    );
  }
}

// ─── Skills root ────────────────────────────────────────────────────────────

/** Resolved path to the bundled skills directory. Can be overridden for testing. */
const DEFAULT_SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
);

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

/**
 * Read the content of a skill's SKILL.md file.
 * Returns null if the file does not exist.
 * Propagates permission errors and other I/O problems so callers can
 * distinguish "skill not found" from "can't access skill".
 */
export function readSkillContent(skillName: string, skillsRoot?: string): string | null {
  const skillFile = path.join(getSkillsRoot(skillsRoot), skillName, 'SKILL.md');
  try {
    return fs.readFileSync(skillFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
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
  throw new Error('install-skill: client writers are not yet implemented');
}

/**
 * Remove a skill's files from the target client's skill directory.
 * STUB — implemented in task 9.9.
 */
export function removeSkillFromClient(_skillName: string, _target: Client, _homeDir: string): void {
  throw new Error('install-skill: client removers are not yet implemented');
}

// ─── Install/Uninstall result ───────────────────────────────────────────────

export interface InstallResult {
  skill: string;
  action: 'installed' | 'uninstalled';
  /** Targets for which the operation succeeded. */
  targets: Client[];
  /** Targets that were skipped (dry-run, unknown, or not applicable). */
  skipped: Client[];
  /** Files would be written but were not (dry-run mode). */
  dryRun: boolean;
}

/**
 * Return codes for `main()`.
 * Exported so callers (e.g. the CLI dispatcher in cli/index.ts) can pass the
 * code to `exit()` without calling `process.exit()` directly.
 */
export const ExitCode = Object.freeze({
  SUCCESS: 0,
  ERR_INVALID_ARGS: 1,
  ERR_SKILL_NOT_FOUND: 2,
  ERR_UNKNOWN_SKILL: 3,
  ERR_NO_TARGETS: 4,
  ERR_WRITER_NOT_IMPLEMENTED: 5,
  ERR_UNKNOWN_TARGET: 7,
  ERR_UNKNOWN: 8,
});

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Install a skill to the specified client targets.
 * - dryRun=true: checks skill existence; does NOT write files or update manifest.
 * - dryRun=false: writes files and updates manifest (requires client writers from tasks 9.5+).
 */
export function doInstall(
  skillName: string,
  targets: Client[],
  opts: { dryRun: boolean; homeDir: string; skillsRoot?: string; version: string },
): InstallResult {
  const checkedPath = path.join(getSkillsRoot(opts.skillsRoot), skillName, 'SKILL.md');
  const content = readSkillContent(skillName, opts.skillsRoot);
  if (!content) {
    throw new SkillNotFoundError(skillName, checkedPath);
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
  opts: { dryRun: boolean; homeDir: string },
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
  /** Explicit --config path, or null if not specified. */
  configPath: string | null;
  uninstall: boolean;
  dryRun: boolean;
  json: boolean;
  targets: Client[] | null;
  allTargets: boolean;
}

/**
 * Parse CLI arguments for `install-skill`.
 *
 * NOTE: `stopEarly` is deliberately NOT set on minimist.  `stopEarly: true`
 * causes options after the first positional argument to be treated as positional
 * tail, which would misparse a call like:
 *     mmagent install-skill mma-delegate --json
 * (--json would be captured in `_` instead of setting the `json` flag).
 * Instead we let minimist consume all arguments normally.
 */
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
    // stopEarly is NOT set — see note above.
  });

  const skill = (args._[0] as string | undefined) ?? null;
  const configPath = typeof args['config'] === 'string' && args['config'].length > 0
    ? args['config']
    : null;
  const uninstall = args['uninstall'] === true;
  const dryRun = args['dry-run'] === true;
  const json = args['json'] === true;
  const allTargets = args['all-targets'] === true;

  let targets: Client[] | null = null;
  if (args.target) {
    const t = Array.isArray(args.target) ? args.target : [args.target];
    targets = (t as string[]).map((s) => s as Client);
  }

  return { skill, configPath, uninstall, dryRun, json, targets, allTargets };
}

/**
 * Resolve the target client list.
 * Priority:
 *   1. explicit `--target` arguments (validated against known clients)
 *   2. `--all-targets` → all four known clients
 *   3. auto-detect based on `homeDir`
 *
 * Explicit targets are de-duplicated while preserving order of first occurrence.
 *
 * @throws UnknownTargetError if an explicit target is not a known client.
 */
export function resolveTargets(
  explicitTargets: Client[] | null,
  allTargets: boolean,
  homeDir: string,
): Client[] {
  if (allTargets) return [...ALL_CLIENTS];

  if (explicitTargets !== null) {
    const seen = new Set<Client>();
    const deduped: Client[] = [];
    for (const t of explicitTargets) {
      if (!ALL_CLIENTS.includes(t)) {
        throw new UnknownTargetError(t, ALL_CLIENTS);
      }
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    return deduped;
  }

  return detectClients(homeDir);
}

// ─── Output helpers ─────────────────────────────────────────────────────────

/**
 * Print an error message.
 * Both branches write through the injectable `stderr` writer for testability.
 */
function printError(
  stderr: (s: string) => boolean,
  json: boolean,
  code: string,
  message: string,
  stdout?: (s: string) => boolean,
): void {
  if (json) {
    // JSON error output goes to stdout so callers can parse it
    const out = stdout ?? process.stdout.write.bind(process.stdout);
    out(JSON.stringify({ error: code, message }) + '\n');
  } else {
    stderr(message + '\n');
  }
}

/**
 * Print a success result.
 * All output goes through the injectable `stdout` writer for testability.
 */
function printResult(
  stdout: (s: string) => boolean,
  result: InstallResult,
  json: boolean,
  manifestUpdated: boolean,
): void {
  if (json) {
    stdout(JSON.stringify(result) + '\n');
  } else {
    const verb = result.action === 'installed' ? 'Installed' : 'Uninstalled';
    const targetStr = result.targets.length > 0 ? ` → ${result.targets.join(', ')}` : '';
    const skippedStr = result.skipped.length > 0 ? ` (dry-run: ${result.skipped.join(', ')})` : '';
    let line = `${verb} '${result.skill}'${targetStr}${skippedStr}\n`;
    if (manifestUpdated) {
      line += 'Manifest updated.\n';
    }
    stdout(line);
  }
}

// ─── argv entry point ────────────────────────────────────────────────────────

export interface MainDeps {
  /** Override argv (defaults to process.argv.slice(2)). */
  argv?: string[];
  /** Home directory (defaults to os.homedir()). */
  homeDir?: string;
  /** Package version string for manifest entries (defaults to '0.0.0'). */
  version?: string;
  /** Override skills root for testing. */
  skillsRoot?: string;
  /** Injectable stdout writer. */
  stdout?: (s: string) => boolean;
  /** Injectable stderr writer. */
  stderr?: (s: string) => boolean;
}

/**
 * Main entry point for `mmagent install-skill`.
 *
 * Returns an exit code (one of `ExitCode.*`) instead of calling `process.exit()`
 * directly, so the CLI dispatcher in `cli/index.ts` can control the exit
 * decision and make the function fully unit-testable.
 */
export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const version = deps.version ?? '0.0.0';
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);

  const { skill, uninstall, dryRun, json, targets: explicitTargets, allTargets } =
    parseArgs(argv);

  // ── 1. Validate skill name ──────────────────────────────────────────────────
  if (!skill) {
    const msg =
      'Usage: mmagent install-skill [--uninstall] [--dry-run] [--json] [--target=<client>] [--all-targets] <skill-name>\n' +
      'Skills: ' + SUPPORTED_SKILLS.join(', ');
    printError(stderr, json, 'missing_skill_name', msg, stdout);
    return ExitCode.ERR_INVALID_ARGS;
  }

  if (!SUPPORTED_SKILLS.includes(skill as (typeof SUPPORTED_SKILLS)[number])) {
    const msg = `Unknown skill '${skill}'. Available: ${SUPPORTED_SKILLS.join(', ')}`;
    printError(stderr, json, 'unknown_skill', msg, stdout);
    return ExitCode.ERR_UNKNOWN_SKILL;
  }

  // ── 2. Resolve targets (may throw UnknownTargetError) ──────────────────────
  let resolvedTargets: Client[];
  try {
    resolvedTargets = resolveTargets(explicitTargets, allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      printError(stderr, json, err.code, err.message, stdout);
      return ExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  // ── 3. Check that at least one target is available ─────────────────────────
  if (resolvedTargets.length === 0) {
    if (json) {
      stdout(
        JSON.stringify({ skill, action: uninstall ? 'uninstalled' : 'installed', targets: [], skipped: [] }) + '\n',
      );
    } else {
      stdout('No clients detected. Use --target or --all-targets to specify targets.\n');
    }
    return ExitCode.ERR_NO_TARGETS;
  }

  // ── 4. Run install/uninstall ──────────────────────────────────────────────
  const opts = { dryRun, homeDir, version, skillsRoot: deps.skillsRoot };

  let result: InstallResult;
  try {
    result = uninstall
      ? doUninstall(skill, resolvedTargets, opts)
      : doInstall(skill, resolvedTargets, opts);
  } catch (err) {
    if (err instanceof SkillNotFoundError) {
      printError(stderr, json, err.code, err.message, stdout);
      return ExitCode.ERR_SKILL_NOT_FOUND;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('client writers are not yet implemented') ||
      msg.includes('client removers are not yet implemented')
    ) {
      printError(stderr, json, 'writer_not_implemented', msg, stdout);
      return ExitCode.ERR_WRITER_NOT_IMPLEMENTED;
    }
    printError(stderr, json, 'unknown', msg, stdout);
    return ExitCode.ERR_UNKNOWN;
  }

  // ── 5. Update manifest (only when not in dry-run mode) ─────────────────────
  let manifestUpdated = false;
  if (!dryRun) {
    if (uninstall) {
      manifest.removeEntry(skill, resolvedTargets, homeDir);
    } else {
      manifest.appendEntry(skill, version, resolvedTargets, homeDir);
    }
    manifestUpdated = true;
  }

  printResult(stdout, result, json, manifestUpdated);

  return ExitCode.SUCCESS;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Robust main-module detection (matching the pattern used in cli/index.ts).
 * Tests import main() directly and pass MainDeps; this function only gates
 * the direct-execution bootstrap so the CLI binary can call main().
 */
function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const thisFile =
      import.meta.url.startsWith('file://')
        ? fileURLToPath(import.meta.url)
        : path.resolve(import.meta.url);
    return path.resolve(argv1) === thisFile;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code));
}
