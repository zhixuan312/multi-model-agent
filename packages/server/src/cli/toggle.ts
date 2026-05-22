/**
 * toggle.ts — `mmagent disable` / `mmagent enable` subcommands.
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
 *   mmagent disable [--target=<client>] [--all-targets] [--dry-run] [--json]
 *   mmagent enable  [--target=<client>] [--all-targets] [--dry-run] [--json]
 *
 * Exit codes:
 *   0 — success (or no clients detected)
 *   1 — one or more skills failed to remove
 *   3 — explicit --target was not a known client
 */
import * as os from 'node:os';
import minimist from 'minimist';
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
import { resolveTargets, runSyncSkills } from './sync-skills.js';

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

interface ToggleArgs {
  targets: Client[] | null;
  allTargets: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseToggleArgs(argv: string[]): ToggleArgs {
  const args = minimist(argv, {
    string: ['target'],
    boolean: ['dry-run', 'json', 'all-targets'],
    alias: { t: 'target', j: 'json' },
  });
  let targets: Client[] | null = null;
  if (args.target) {
    const t = Array.isArray(args.target) ? args.target : [args.target];
    targets = (t as string[]).map((s) => s as Client);
  }
  return {
    targets,
    allTargets: args['all-targets'] === true,
    dryRun: args['dry-run'] === true,
    json: args['json'] === true,
  };
}

/**
 * `mmagent disable` — remove all MMA skills from the resolved clients and
 * record the sticky sentinel.
 */
export async function runDisable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const cliVersion = deps.cliVersion ?? 'unknown';
  const parsed = parseToggleArgs(argv);

  let targets: Client[];
  try {
    targets = resolveTargets(parsed.targets, parsed.allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mmagent disable: ${err.message}\n`);
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
    if (!parsed.dryRun) stdout('Run `mmagent enable` to restore.\n');
    for (const e of errors) stderr(`error: ${e.skill} → ${e.target}: ${e.reason}\n`);
  }

  return errors.length > 0 ? ToggleExitCode.ERR_PARTIAL : ToggleExitCode.SUCCESS;
}

/**
 * `mmagent enable` — clear the sentinel for the resolved clients, then
 * delegate to sync-skills' idempotent upsert to reinstall the skills.
 */
export async function runEnable(deps: ToggleDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const parsed = parseToggleArgs(argv);

  let targets: Client[];
  try {
    targets = resolveTargets(parsed.targets, parsed.allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mmagent enable: ${err.message}\n`);
      return ToggleExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  const wasDisabled = disabledTargets(homeDir);

  // Clear the sentinel BEFORE syncing — otherwise sync-skills would see the
  // targets as still-disabled and skip them. On --dry-run, leave it intact.
  if (!parsed.dryRun) {
    // No explicit --target means "re-enable everything", so clear the whole set.
    const toClear = parsed.targets === null && !parsed.allTargets ? [...ALL_CLIENTS] : targets;
    clearDisabledTargets(homeDir, toClear);
  }

  if (wasDisabled.length === 0) {
    stdout('MMA skills were not disabled; syncing to ensure they are installed.\n');
  }

  // Reinstall via the canonical upsert. Pass the same argv so --target /
  // --dry-run / --json flow straight through to sync-skills' own parser.
  return runSyncSkills({
    argv,
    homeDir,
    skillsRoot: deps.skillsRoot,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}
