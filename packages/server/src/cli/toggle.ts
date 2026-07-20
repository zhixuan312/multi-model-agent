/**
 * toggle.ts — `mma disable` / `mma enable` subcommands.
 *
 * disable: remove every shipped skill from the resolved clients, drop their
 *   manifest entries, and record a sticky sentinel so a later `npm install`
 *   postinstall (which shells out to `sync-skills`) does not silently
 *   reinstall them. This is the only "off switch" that survives an upgrade.
 * enable: clear the sentinel for the resolved clients, then run the normal
 *   sync-skills upsert to reinstall the skills.
 *
 * Both reuse sync-skills' target resolution so `--target` / `--all-targets`
 * behave identically across all three commands.
 *
 * Usage:
 *   mma disable [--target=<client>] [--all-targets] [--dry-run] [--json]
 *   mma enable  [--target=<client>] [--all-targets] [--dry-run] [--json]
 *
 * Exit codes:
 *   0 — success (or no clients detected)
 *   1 — one or more skills failed to remove
 *   3 — explicit --target was not a known client
 */
import * as os from 'node:os';
import { removeEntry, ALL_CLIENTS, type Client } from '../skill-install/manifest.js';
import { SUPPORTED_SKILLS } from '../skill-install/discover.js';
import {
  removeSkillFromClient,
  UnknownTargetError,
} from '../skill-install/skill-installer-common.js';
import {
  addDisabledTargets,
  clearDisabledTargets,
  disabledTargets,
} from '../skill-install/disabled-state.js';
import { resolveTargets, runSyncSkills, parseArgs } from './sync-skills.js';

export const ToggleExitCode = Object.freeze({
  SUCCESS: 0,
  ERR_PARTIAL: 1,
  ERR_UNKNOWN_TARGET: 3,
});

export interface ToggleDeps {
  argv?: string[];
  homeDir?: string;
  /** Override skills root — threaded into runSyncSkills for `enable` in tests. */
  skillsRoot?: string;
  /** Recorded in the sentinel for diagnostics; defaults to 'unknown'. */
  cliVersion?: string;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}


/**
 * `mma disable` — remove all MMA skills from the resolved clients and
 * record the sticky sentinel.
 */
export async function runDisable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const cliVersion = deps.cliVersion ?? 'unknown';
  const parsed = parseArgs(argv);

  let targets: Client[];
  try {
    targets = resolveTargets(parsed.targets, parsed.allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mma disable: ${err.message}\n`);
      return ToggleExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  if (targets.length === 0) {
    if (parsed.json) {
      stdout(JSON.stringify({ action: 'disable', targets: [], outcome: 'no-clients-detected' }) + '\n');
    } else {
      stdout('No clients detected. Use --target=<client> or --all-targets.\n');
    }
    return ToggleExitCode.SUCCESS;
  }

  const removed: Array<{ skill: string; target: Client }> = [];
  const errors: Array<{ skill: string; target: Client; reason: string }> = [];

  if (parsed.dryRun) {
    for (const target of targets) {
      for (const skill of SUPPORTED_SKILLS) removed.push({ skill, target });
    }
  } else {
    for (const target of targets) {
      for (const skill of SUPPORTED_SKILLS) {
        try {
          removeSkillFromClient(skill, target, homeDir);
          removed.push({ skill, target });
        } catch (err) {
          errors.push({
            skill,
            target,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    for (const skill of SUPPORTED_SKILLS) removeEntry(skill, targets, homeDir);
    addDisabledTargets(homeDir, targets, cliVersion);
  }

  if (parsed.json) {
    stdout(
      JSON.stringify({
        action: 'disable',
        dryRun: parsed.dryRun,
        targets,
        removed: removed.length,
        errors,
      }) + '\n',
    );
  } else {
    const verb = parsed.dryRun ? 'Would disable' : 'Disabled';
    const errClause = errors.length > 0 ? `, ${errors.length} errors` : '';
    stdout(`${verb} MMA skills → ${targets.join(', ')} (${removed.length} removed${errClause}).\n`);
    if (!parsed.dryRun) stdout('Run `mma enable` to restore.\n');
    for (const e of errors) stderr(`error: ${e.skill} → ${e.target}: ${e.reason}\n`);
  }

  return errors.length > 0 ? ToggleExitCode.ERR_PARTIAL : ToggleExitCode.SUCCESS;
}

/**
 * `mma enable` — clear the sentinel for the resolved clients, then
 * delegate to sync-skills' idempotent upsert to reinstall the skills.
 */
export async function runEnable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const parsed = parseArgs(argv);

  let targets: Client[];
  try {
    targets = resolveTargets(parsed.targets, parsed.allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mma enable: ${err.message}\n`);
      return ToggleExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  const wasDisabled = disabledTargets(homeDir);
  const bare = parsed.targets === null && !parsed.allTargets;

  // Clear the sentinel BEFORE syncing — otherwise sync-skills would see the
  // targets as still-disabled and skip them. On --dry-run, leave it intact.
  if (!parsed.dryRun) {
    // No explicit --target means "re-enable everything", so clear the whole set.
    const toClear = bare ? [...ALL_CLIENTS] : targets;
    clearDisabledTargets(homeDir, toClear);
  }

  if (wasDisabled.length === 0) {
    stdout('MMA skills were not disabled; syncing to ensure they are installed.\n');
  }

  // Reinstall via the canonical upsert. For a bare `enable`, sync-skills would
  // otherwise touch only auto-detected clients (claude-code / codex) and skip
  // a previously `disable --target=cursor` — un-pinning it without restoring
  // it. So when no explicit target is given, sync the union of detected
  // clients and whatever was pinned off, making `enable` actually restore what
  // `disable` removed. Explicit --target / --all-targets pass straight through.
  let syncArgv = argv;
  if (bare && wasDisabled.length > 0) {
    const detected = resolveTargets(null, false, homeDir);
    const union = ALL_CLIENTS.filter((c) => detected.includes(c) || wasDisabled.includes(c));
    syncArgv = [...argv, ...union.map((c) => `--target=${c}`)];
  }

  return runSyncSkills({
    argv: syncArgv,
    homeDir,
    skillsRoot: deps.skillsRoot,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}
