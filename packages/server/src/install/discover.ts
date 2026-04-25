// Skill discovery — locates packaged SKILL.md files on disk and reads them.
// Extracted from cli/install-skill.ts as part of Ch 7 Task 39.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'mma-investigate',
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

const DEFAULT_SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
);

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
