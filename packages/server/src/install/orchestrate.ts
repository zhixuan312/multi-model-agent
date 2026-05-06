// Install/uninstall orchestration. Pure logic — no CLI/argv handling.
// Extracted from cli/install-skill.ts as part of Ch 7 Task 39.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@zhixuan92/multi-model-agent-core/tool-surface/manifest';
import { SkillNotFoundError, getSkillsRoot, readSkillContent, SUPPORTED_SKILLS } from '@zhixuan92/multi-model-agent-core/tool-surface/discover';
import {
  writeSkillToClient,
  removeSkillFromClient,
  resolveClientInstallDir,
} from './manifest-resolve.js';

export interface InstallResult {
  skill: string;
  action: 'installed' | 'uninstalled';
  /** Targets for which the operation succeeded. */
  targets: Client[];
  /** Targets that were skipped (dry-run, unknown, or not applicable). */
  skipped: Client[];
  /** Files would be written but were not (dry-run mode). */
  dryRun: boolean;
  /** Orphaned skill names removed during cleanup, per client. */
  orphanedSkills?: Partial<Record<Client, string[]>>;
}

/**
 * Scan an install directory for `mma-*` subdirectories and remove any that
 * are not in `canonicalSkills`. Returns the list of removed skill names.
 *
 * Only applies to clients that use per-skill directories (claude-code, codex).
 * Gemini and Cursor use single-file models and are handled separately.
 */
export function activeCleanup(installDir: string, canonicalSkills: readonly string[]): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(installDir);
  } catch {
    return [];
  }
  const present = entries.filter((name) => name.startsWith('mma-'));
  const orphaned = present.filter((name) => !canonicalSkills.includes(name));
  for (const orphan of orphaned) {
    const dirPath = path.join(installDir, orphan);
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  return orphaned;
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
    /** When true, scan install dirs and remove orphaned mma-* skills not in SUPPORTED_SKILLS. */
    cleanupOrphans?: boolean;
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

  // Active cleanup: runs after writes complete. Opt-in so single-skill
  // invocations don't accidentally wipe other canonical skills.
  let orphanedSkills: Partial<Record<Client, string[]>> | undefined;
  if (opts.cleanupOrphans && !opts.dryRun) {
    orphanedSkills = {};
    for (const target of targets) {
      const installDir = resolveClientInstallDir(target, opts.homeDir);
      if (installDir !== null) {
        const removed = activeCleanup(installDir, SUPPORTED_SKILLS);
        if (removed.length > 0) orphanedSkills[target] = removed;
      }
    }
  }

  return {
    skill: skillName,
    action: 'installed',
    targets: installed,
    skipped,
    dryRun: opts.dryRun,
    ...(orphanedSkills ? { orphanedSkills } : {}),
  };
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
