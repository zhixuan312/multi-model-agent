/**
 * sync-skills.ts — `mma sync-skills` subcommand.
 *
 * Single command for skill management: idempotent upsert of every shipped
 * skill into every detected (or specified) client. Compares canonical
 * SUPPORTED_SKILLS against on-disk SKILL.md and the install manifest, and:
 *   - installs skills not present on disk
 *   - overwrites skills whose installed version differs from canonical
 *   - removes skills no longer in SUPPORTED_SKILLS (orphan cleanup)
 *   - rewrites the install manifest to reflect post-sync state
 *
 * Replaces install-skill + update-skills as of 4.0.2.
 *
 * Usage:
 *   mma sync-skills [--target=<client>] [--all-targets] [--dry-run] [--json]
 *                       [--silent] [--best-effort] [--if-exists]
 *
 * Exit codes:
 *   0 — success (or no clients detected)
 *   1 — one or more skills failed to write/remove
 *   2 — manifest was written by a newer mma (FutureManifestError)
 *   3 — explicit --target was not a known client
 */
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import matter from 'gray-matter';
import {
  ALL_CLIENTS,
  detectClients,
  listEntries,
  appendEntry,
  removeEntry,
  FutureManifestError,
  type Client,
  type ManifestEntry,
} from '../skill-install/manifest.js';
import {
  SUPPORTED_SKILLS,
  readSkillContent,
  getSkillsRoot,
} from '../skill-install/discover.js';
import {
  writeSkillToClient,
  removeSkillFromClient,
  resolveClientInstallDir,
  UnknownTargetError,
} from '../skill-install/skill-installer-common.js';
import { disabledTargets } from '../skill-install/disabled-state.js';

export const ExitCode = Object.freeze({
  SUCCESS: 0,
  ERR_PARTIAL: 1,
  ERR_FUTURE_MANIFEST: 2,
  ERR_UNKNOWN_TARGET: 3,
});

export interface SyncSkillsDeps {
  argv?: string[];
  homeDir?: string;
  /** Override skills root for testing. */
  skillsRoot?: string;
  /** Exit silently with code 0 if no manifest exists yet (postinstall). */
  ifExists?: boolean;
  /** Suppress normal stdout. Errors still go to stderr. */
  silent?: boolean;
  /** Swallow errors and exit 0 (postinstall). */
  bestEffort?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

interface ParsedArgs {
  targets: Client[] | null;
  allTargets: boolean;
  dryRun: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
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

export function resolveTargets(
  explicit: Client[] | null,
  allTargets: boolean,
  homeDir: string,
): Client[] {
  if (allTargets) return [...ALL_CLIENTS];
  if (explicit !== null) {
    for (const t of explicit) {
      if (!ALL_CLIENTS.includes(t)) throw new UnknownTargetError(t, ALL_CLIENTS);
    }
    return Array.from(new Set(explicit));
  }
  return detectClients(homeDir);
}

function versionFromContent(content: string): string {
  try {
    const parsed = matter(content);
    const v = parsed.data['version'];
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function manifestPresent(homeDir: string): boolean {
  return fs.existsSync(path.join(homeDir, '.mma', 'install-manifest.json'));
}

function readInstalledVersion(skillName: string, target: Client, homeDir: string): string | null {
  const dir = resolveClientInstallDir(target, homeDir);
  if (!dir) return null;
  const skillFile = path.join(dir, skillName, 'SKILL.md');
  try {
    return versionFromContent(fs.readFileSync(skillFile, 'utf8'));
  } catch {
    return null;
  }
}

export interface SyncOutcome {
  installed: Array<{ skill: string; target: Client; version: string }>;
  updated: Array<{ skill: string; target: Client; from: string; to: string }>;
  removed: Array<{ skill: string; target: Client }>;
  upToDate: Array<{ skill: string; target: Client }>;
  errors: Array<{ skill: string; target: Client; reason: string }>;
}

export async function runSyncSkills(deps: SyncSkillsDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const homeDir = deps.homeDir ?? os.homedir();
  const skillsRoot = getSkillsRoot(deps.skillsRoot);
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const silent = deps.silent ?? false;
  const bestEffort = deps.bestEffort ?? false;
  const log = silent ? (_: string) => true : stdout;

  if (deps.ifExists && !manifestPresent(homeDir)) return ExitCode.SUCCESS;

  let authToken: string | undefined;
  try {
    const tokenPath = path.join(homeDir, '.mma', 'auth-token');
    if (fs.existsSync(tokenPath)) {
      authToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch { /* best-effort — skills work without embedded token */ }

  const parsed = parseArgs(argv);

  let targets: Client[];
  try {
    targets = resolveTargets(parsed.targets, parsed.allTargets, homeDir);
  } catch (err) {
    if (err instanceof UnknownTargetError) {
      stderr(`mma sync-skills: ${err.message}\n`);
      return bestEffort ? 0 : ExitCode.ERR_UNKNOWN_TARGET;
    }
    throw err;
  }

  // Honor the disable sentinel: drop any client the user turned off via
  // `mma disable`. This is what makes disable sticky — the npm postinstall
  // hook shells out to this command, so without the filter every upgrade would
  // silently reinstall skills the user deliberately removed. `mma enable`
  // clears the sentinel before it calls back in here.
  const disabled = disabledTargets(homeDir);
  if (disabled.length > 0) {
    const active = targets.filter((t) => !disabled.includes(t));
    if (active.length === 0) {
      if (parsed.json) {
        stdout(JSON.stringify({ targets: [], outcome: 'skills-disabled', disabled }) + '\n');
      } else {
        log(
          `MMA skills are disabled for ${disabled.join(', ')}. ` +
          `Run \`mma enable\` to restore. Skipping sync.\n`,
        );
      }
      return ExitCode.SUCCESS;
    }
    targets = active;
  }

  if (targets.length === 0) {
    if (parsed.json) {
      stdout(JSON.stringify({ targets: [], outcome: 'no-clients-detected' }) + '\n');
    } else {
      log('No clients detected. Use --target=<client> or --all-targets.\n');
    }
    return ExitCode.SUCCESS;
  }

  let manifestEntries: ManifestEntry[];
  try {
    manifestEntries = listEntries(homeDir);
  } catch (err) {
    if (err instanceof FutureManifestError) {
      stderr(`mma sync-skills: ${err.message}\n`);
      return bestEffort ? 0 : ExitCode.ERR_FUTURE_MANIFEST;
    }
    if (bestEffort) return 0;
    throw err;
  }

  const outcome: SyncOutcome = {
    installed: [],
    updated: [],
    removed: [],
    upToDate: [],
    errors: [],
  };

  // Pass 1: orphan removal — drop skills that disappeared from the bundle.
  for (const entry of manifestEntries) {
    if ((SUPPORTED_SKILLS as readonly string[]).includes(entry.name)) continue;
    for (const target of entry.targets) {
      if (parsed.dryRun) {
        outcome.removed.push({ skill: entry.name, target });
        continue;
      }
      try {
        removeSkillFromClient(entry.name, target, homeDir);
        outcome.removed.push({ skill: entry.name, target });
      } catch (err) {
        outcome.errors.push({
          skill: entry.name,
          target,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!parsed.dryRun) removeEntry(entry.name, [], homeDir);
  }

  // Pass 2: upsert canonical skills × resolved targets.
  for (const skillName of SUPPORTED_SKILLS) {
    const content = readSkillContent(skillName, skillsRoot);
    if (content === null) {
      outcome.errors.push({
        skill: skillName,
        target: targets[0]!,
        reason: `Bundled SKILL.md not found at ${path.join(skillsRoot, skillName, 'SKILL.md')}`,
      });
      continue;
    }
    const canonicalVersion = versionFromContent(content);

    for (const target of targets) {
      const installedVersion = readInstalledVersion(skillName, target, homeDir);
      const action: 'install' | 'update' | 'up-to-date' =
        installedVersion === null
          ? 'install'
          : installedVersion !== canonicalVersion
            ? 'update'
            : 'up-to-date';

      if (action === 'up-to-date') {
        outcome.upToDate.push({ skill: skillName, target });
        continue;
      }

      if (parsed.dryRun) {
        if (action === 'install') {
          outcome.installed.push({ skill: skillName, target, version: canonicalVersion });
        } else {
          outcome.updated.push({ skill: skillName, target, from: installedVersion!, to: canonicalVersion });
        }
        continue;
      }

      try {
        writeSkillToClient(skillName, content, target, homeDir, skillsRoot, canonicalVersion, process.cwd(), false, authToken);
        appendEntry(skillName, canonicalVersion, [target], homeDir);
        if (action === 'install') {
          outcome.installed.push({ skill: skillName, target, version: canonicalVersion });
        } else {
          outcome.updated.push({ skill: skillName, target, from: installedVersion!, to: canonicalVersion });
        }
      } catch (err) {
        outcome.errors.push({
          skill: skillName,
          target,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (parsed.json) {
    stdout(JSON.stringify({ dryRun: parsed.dryRun, targets, outcome }) + '\n');
  } else {
    const verb = parsed.dryRun ? 'Would sync' : 'Synced';
    const parts: string[] = [];
    if (outcome.installed.length > 0) parts.push(`${outcome.installed.length} installed`);
    if (outcome.updated.length > 0) parts.push(`${outcome.updated.length} updated`);
    if (outcome.removed.length > 0) parts.push(`${outcome.removed.length} orphan removed`);
    if (outcome.upToDate.length > 0) parts.push(`${outcome.upToDate.length} up-to-date`);
    if (outcome.errors.length > 0) parts.push(`${outcome.errors.length} errors`);
    const summary = parts.length > 0 ? parts.join(', ') : 'nothing to do';
    log(`${verb} ${SUPPORTED_SKILLS.length} skill(s) → ${targets.join(', ')} (${summary}).\n`);
    for (const e of outcome.errors) stderr(`error: ${e.skill} → ${e.target}: ${e.reason}\n`);
  }

  if (outcome.errors.length > 0) return bestEffort ? 0 : ExitCode.ERR_PARTIAL;
  return ExitCode.SUCCESS;
}
