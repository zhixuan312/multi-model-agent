/**
 * update-skills.ts — `mmagent update-skills` subcommand.
 *
 * Iterates over every entry in the install manifest and re-copies the
 * shipped SKILL.md for that skill to each of its installed targets,
 * updating `skillVersion` from the current bundle. Skills that have
 * disappeared from the bundle since a previous install are removed from
 * every target and dropped from the manifest.
 *
 * Exit codes:
 *   0 — success (possibly with no manifest entries)
 *   1 — one or more targets failed to update
 *   2 — manifest was written by a newer mmagent (FutureManifestError)
 *
 * Usage:
 *   mmagent update-skills [--dry-run] [--json] [--if-exists] [--silent] [--best-effort]
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import matter from 'gray-matter';
import {
  FutureManifestError,
  listEntries,
  removeEntry,
  appendEntry,
  type ManifestEntry,
  type Client,
} from '@zhixuan92/multi-model-agent-core/tool-surface/manifest';
import {
  readSkillContent,
  writeSkillToClient,
  removeSkillFromClient,
  getSkillsRoot,
} from './install-skill.js';
import { findMissingSkills } from '../install/missing-skills.js';
import { SUPPORTED_SKILLS } from '@zhixuan92/multi-model-agent-core/tool-surface/discover';

export interface UpdateSkillsDeps {
  homeDir?: string;
  skillsRoot?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Exit silently with code 0 if no manifest exists. Used by postinstall. */
  ifExists?: boolean;
  /** Suppress normal stdout logging (errors still go to stderr). */
  silent?: boolean;
  /** Swallow any thrown error and exit 0. Used by postinstall. */
  bestEffort?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

interface UpdateSummary {
  updated: string[];
  removed: string[];
  errors: { skill: string; target: Client; reason: string }[];
}

function versionFromSkillContent(content: string): string {
  try {
    const parsed = matter(content);
    const v = parsed.data['version'];
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function manifestPresent(homeDir: string): boolean {
  return fs.existsSync(path.join(homeDir, '.multi-model', 'install-manifest.json'));
}

export async function runUpdateSkills(deps: UpdateSkillsDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const homeDir = deps.homeDir ?? os.homedir();
  const skillsRoot = getSkillsRoot(deps.skillsRoot);
  const dryRun = deps.dryRun ?? false;
  const json = deps.json ?? false;
  const silent = deps.silent ?? false;
  const bestEffort = deps.bestEffort ?? false;
  const logInfo = silent ? (_: string) => true : stdout;

  if (deps.ifExists && !manifestPresent(homeDir)) {
    return 0;
  }

  let entries: ManifestEntry[];
  try {
    entries = listEntries(homeDir);
  } catch (err) {
    if (err instanceof FutureManifestError) {
      stderr(`mmagent update-skills: ${err.message}\n`);
      return bestEffort ? 0 : 2;
    }
    if (bestEffort) return 0;
    throw err;
  }

  const summary: UpdateSummary = { updated: [], removed: [], errors: [] };

  for (const entry of entries) {
    const content = readSkillContent(entry.name, skillsRoot);

    if (content === null) {
      // Skill has been removed from the shipped bundle — remove from every
      // target and drop the manifest entry.
      if (!dryRun) {
        for (const target of entry.targets) {
          try {
            removeSkillFromClient(entry.name, target, homeDir);
          } catch (err) {
            summary.errors.push({
              skill: entry.name,
              target,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        removeEntry(entry.name, [], homeDir);
      }
      summary.removed.push(entry.name);
      continue;
    }

    const newSkillVersion = versionFromSkillContent(content);

    for (const target of entry.targets) {
      if (dryRun) {
        logInfo(`Would update: ${entry.name} → ${target} (${entry.skillVersion} → ${newSkillVersion})\n`);
        continue;
      }
      try {
        writeSkillToClient(entry.name, content, target, homeDir, skillsRoot, newSkillVersion);
      } catch (err) {
        summary.errors.push({
          skill: entry.name,
          target,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!dryRun) {
      appendEntry(entry.name, newSkillVersion, entry.targets, homeDir);
    }
    summary.updated.push(entry.name);
  }

  // Backfill: install skills that are in SUPPORTED_SKILLS but missing from the
  // manifest (e.g. mma-investigate added in a later release). Targets are the
  // union of all client targets already opted into.
  const postEntries = listEntries(homeDir);
  const missing = findMissingSkills(postEntries, SUPPORTED_SKILLS as unknown as readonly string[]);
  for (const m of missing) {
    const content = readSkillContent(m.name, skillsRoot);
    if (content === null) continue;
    const skillVersion = versionFromSkillContent(content);
    if (!silent) logInfo(`[mmagent] installing missing skill: ${m.name} → ${m.targets.join(', ')}\n`);
    for (const target of m.targets) {
      try {
        writeSkillToClient(m.name, content, target, homeDir, skillsRoot, skillVersion);
      } catch (err) {
        summary.errors.push({
          skill: m.name,
          target,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!dryRun) {
      appendEntry(m.name, skillVersion, m.targets, homeDir);
    }
    summary.updated.push(m.name);
  }

  if (json) {
    stdout(JSON.stringify(summary) + '\n');
  } else {
    for (const name of summary.updated) logInfo(`Updated: ${name}\n`);
    for (const name of summary.removed) logInfo(`Removed: ${name} (no longer shipped)\n`);
    for (const e of summary.errors) stderr(`error: ${e.skill} → ${e.target}: ${e.reason}\n`);
    if (!silent) logInfo(`Manifest updated (${summary.updated.length} updated, ${summary.removed.length} removed, ${summary.errors.length} errors).\n`);
  }

  if (summary.errors.length > 0) {
    return bestEffort ? 0 : 1;
  }
  return 0;
}
