// Install/uninstall orchestration. Pure logic — no CLI/argv handling.
// Extracted from cli/install-skill.ts as part of Ch 7 Task 39.
import path from 'node:path';
import type { Client } from './manifest.js';
import { SkillNotFoundError, getSkillsRoot, readSkillContent } from './discover.js';
import { writeSkillToClient, removeSkillFromClient } from './manifest-resolve.js';

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
 * Install a skill to the specified client targets.
 * - dryRun=true: checks skill existence; does NOT write files or update manifest.
 * - dryRun=false: writes files via the per-client writers.
 */
export function doInstall(
  skillName: string,
  targets: Client[],
  opts: {
    dryRun: boolean;
    homeDir: string;
    skillsRoot?: string;
    version?: string;
    cwd?: string;
    force?: boolean;
  },
): InstallResult {
  const checkedPath = path.join(getSkillsRoot(opts.skillsRoot), skillName, 'SKILL.md');
  const content = readSkillContent(skillName, opts.skillsRoot);
  if (!content) {
    throw new SkillNotFoundError(skillName, checkedPath);
  }

  const skillsRoot = getSkillsRoot(opts.skillsRoot);
  const version = opts.version ?? '0.0.0';
  const cwd = opts.cwd ?? process.cwd();

  const installed: Client[] = [];
  const skipped: Client[] = [];

  for (const target of targets) {
    if (opts.dryRun) {
      skipped.push(target);
    } else {
      writeSkillToClient(skillName, content, target, opts.homeDir, skillsRoot, version, cwd, opts.force);
      installed.push(target);
    }
  }

  return { skill: skillName, action: 'installed', targets: installed, skipped, dryRun: opts.dryRun };
}

/**
 * Uninstall a skill from the specified client targets.
 * - dryRun=true: resolves targets; does NOT remove files or update manifest.
 * - dryRun=false: removes files via the per-client removers.
 */
export function doUninstall(
  skillName: string,
  targets: Client[],
  opts: { dryRun: boolean; homeDir: string; cwd?: string },
): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const installed: Client[] = [];
  const skipped: Client[] = [];

  for (const target of targets) {
    if (opts.dryRun) {
      skipped.push(target);
    } else {
      removeSkillFromClient(skillName, target, opts.homeDir, cwd);
      installed.push(target);
    }
  }

  return { skill: skillName, action: 'uninstalled', targets: installed, skipped, dryRun: opts.dryRun };
}
