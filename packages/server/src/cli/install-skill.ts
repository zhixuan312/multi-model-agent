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
 * Tasks 9.5–9.8: Individual client writers.
 * Task 9.9: Uninstall wires all removers.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import minimist from 'minimist';
import * as manifest from '../install/manifest.js';
import type { Client } from '../install/manifest.js';
import { ALL_CLIENTS, detectClients } from '../install/manifest.js';
import {
  SUPPORTED_SKILLS,
  SkillNotFoundError,
  getSkillsRoot,
  readSkillContent,
} from '../install/discover.js';
import {
  UnknownTargetError,
  writeSkillToClient,
  removeSkillFromClient,
} from '../install/manifest-resolve.js';

// Re-export everything callers (cli/index.ts + tests) imported from here.
export type { Client } from '../install/manifest.js';
export { ALL_CLIENTS, detectClients } from '../install/manifest.js';
export {
  SUPPORTED_SKILLS,
  SkillNotFoundError,
  getSkillsRoot,
  readSkillContent,
} from '../install/discover.js';
export {
  UnknownTargetError,
  writeSkillToClient,
  removeSkillFromClient,
} from '../install/manifest-resolve.js';

// ─── Install/Uninstall result ───────────────────────────────────────────────

export type { InstallResult } from '../install/orchestrate.js';
export { doInstall, doUninstall } from '../install/orchestrate.js';
import { doInstall, doUninstall, type InstallResult } from '../install/orchestrate.js';

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

  // ── 1. Validate skill selection ────────────────────────────────────────────
  // Default: install every shipped skill. Specify a positional skill name to
  // scope to a single skill.
  if (skill && !SUPPORTED_SKILLS.includes(skill as (typeof SUPPORTED_SKILLS)[number])) {
    const msg = `Unknown skill '${skill}'. Available: ${SUPPORTED_SKILLS.join(', ')}`;
    printError(stderr, json, 'unknown_skill', msg, stdout);
    return ExitCode.ERR_UNKNOWN_SKILL;
  }

  const skillsToRun: readonly string[] = skill ? [skill] : SUPPORTED_SKILLS;

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
        JSON.stringify({ skills: skillsToRun, action: uninstall ? 'uninstalled' : 'installed', targets: [], skipped: [] }) + '\n',
      );
    } else {
      stdout('No clients detected. Use --target or --all-targets to specify targets.\n');
    }
    return ExitCode.ERR_NO_TARGETS;
  }

  // ── 4. Run install/uninstall (loops over skillsToRun; same logic per skill) ─
  const opts = { dryRun, homeDir, version, skillsRoot: deps.skillsRoot };

  let firstError: number | null = null;
  let manifestUpdated = false;

  for (const s of skillsToRun) {
    let result: InstallResult;
    try {
      result = uninstall
        ? doUninstall(s, resolvedTargets, opts)
        : doInstall(s, resolvedTargets, opts);
    } catch (err) {
      if (err instanceof SkillNotFoundError) {
        printError(stderr, json, err.code, err.message, stdout);
        if (firstError === null) firstError = ExitCode.ERR_SKILL_NOT_FOUND;
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('client writers are not yet implemented') ||
        msg.includes('client removers are not yet implemented')
      ) {
        printError(stderr, json, 'writer_not_implemented', msg, stdout);
        if (firstError === null) firstError = ExitCode.ERR_WRITER_NOT_IMPLEMENTED;
        continue;
      }
      printError(stderr, json, 'unknown', msg, stdout);
      if (firstError === null) firstError = ExitCode.ERR_UNKNOWN;
      continue;
    }

    if (!dryRun) {
      if (uninstall) {
        manifest.removeEntry(s, resolvedTargets, homeDir);
      } else {
        manifest.appendEntry(s, version, resolvedTargets, homeDir);
      }
      manifestUpdated = true;
    }

    printResult(stdout, result, json, manifestUpdated);
  }

  return firstError ?? ExitCode.SUCCESS;
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
