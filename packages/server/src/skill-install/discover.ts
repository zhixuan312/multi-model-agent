// Skill discovery — locates packaged SKILL.md files on disk and reads them.
// Extracted from cli/install-skill.ts as part of Ch 7 Task 39.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from './manifest.js';

export const SUPPORTED_SKILLS = [
  'multi-model-agent',
  'mma-delegate',
  'mma-audit',
  'mma-review',
  'mma-debug',
  'mma-execute-plan',
  'mma-retry',
  'mma-context-blocks',
  'mma-investigate',
  'mma-research',
  'mma-explore',
  'mma-journal-record',
  'mma-journal-recall',
  'mma-orchestrate',
] as const;

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

// Skills are bundled at `packages/server/src/skills/` (copied to
// `packages/server/dist/skills/` at build time, shipped on the npm package).
// Probe candidates for monorepo dev layouts and both npm-installed layouts
// (hoisted siblings, or core nested under server).
export function skillsRootCandidates(here: string): string[] {
  return [
    // Dev source: packages/server/src/skill-install -> packages/server/src/skills
    path.resolve(here, '..', 'skills'),
    // Dev built: packages/server/dist/skill-install -> packages/server/dist/skills
    path.resolve(here, '..', 'skills'),
    // Core dev: packages/core/src/unified -> packages/server/src/skills
    path.resolve(here, '..', '..', '..', 'server', 'src', 'skills'),
    // Core built: packages/core/dist/unified -> packages/server/dist/skills
    path.resolve(here, '..', '..', '..', 'server', 'dist', 'skills'),
    // npm install (hoisted)
    path.resolve(here, '..', '..', '..', 'multi-model-agent', 'dist', 'skills'),
    // npm install (core nested under server)
    path.resolve(here, '..', '..', '..', '..', '..', 'dist', 'skills'),
  ];
}

export function pickSkillsRoot(
  here: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const candidates = skillsRootCandidates(here);
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return candidates[0]!;
}

const DEFAULT_SKILLS_ROOT = pickSkillsRoot(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Return the absolute path to the skills root directory. Production: the
 * bundled `packages/server/src/skills/` (or its dist mirror). Tests pass
 * a fixture path explicitly.
 */
export function getSkillsRoot(skillsRoot?: string): string {
  return skillsRoot ?? DEFAULT_SKILLS_ROOT;
}

/**
 * Read the content of a skill's SKILL.md file. Returns null if the file
 * does not exist; propagates other I/O errors so callers can distinguish
 * "skill not found" from "can't access skill".
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

/**
 * Return the per-client install directories where skills are written as
 * subdirectories. Only includes clients that use the per-skill directory
 * model (claude-code and codex). Gemini and Cursor bundle skills into a
 * single file/extension and are not included.
 */
export function discoverPerClientInstallDirs(homeDir?: string): Partial<Record<Client, string>> {
  const h = homeDir ?? os.homedir();
  return {
    'claude-code': path.join(h, '.claude', 'skills'),
    'codex': path.join(h, '.codex', 'skills'),
  };
}
