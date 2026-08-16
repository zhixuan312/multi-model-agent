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
  'mma-debug',
  'mma-execute-plan',
  'mma-context-blocks',
  'mma-investigate',
  'mma-research',
  'mma-explore',
  'mma-brainstorm',
  'mma-journal-record',
  'mma-journal-recall',
  'mma-orchestrate',
  'mma-spec',
  'mma-plan',
  'mma-solution-lead',
] as const;

/**
 * Commands are Claude Code-only packaged assets installed to
 * `~/.claude/commands/<name>.md`. They are explicitly invoked by the user
 * via `/<name>` — unlike skills, which are auto-matched by intent.
 */
export const SUPPORTED_COMMANDS = [
  'mma-flow',
  'mma-breakout',
  'mma-tldr',
  'mma-deck',
] as const;

// Skills are bundled at `packages/server/src/skills/` (copied to
// `packages/server/dist/skills/` at build time, shipped on the npm package).
// Probe candidates for monorepo dev layouts and both npm-installed layouts
// (hoisted siblings, or core nested under server).
function skillsRootCandidates(here: string): string[] {
  return [
    // Same-package sibling: covers BOTH dev source (packages/server/src/skill-install
    // -> src/skills) and dev built (packages/server/dist/skill-install -> dist/skills),
    // because `here` already resolves to the right src/ or dist/ root at runtime.
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

function pickSkillsRoot(
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
 * A skill/command name addresses exactly one directory directly under the skills root — never a
 * path. Names reach here from `install-manifest.json`, which is a plain file on disk that a corrupt
 * write or a hand edit can put anything into, and `path.join` would happily honour `..` (reading
 * outside the root) or `mma-audit/SKILL.md` (joining to `…/SKILL.md/SKILL.md`, which raises ENOTDIR
 * rather than ENOENT and so propagates out of the read). Treat a non-segment name as "no such
 * skill" — which is what it is.
 */
function isPlainSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

/**
 * Read the content of a skill's SKILL.md file. Returns null if the file
 * does not exist — or if the name is not a plain directory segment; propagates
 * other I/O errors so callers can distinguish "skill not found" from "can't
 * access skill".
 */
export function readSkillContent(skillName: string, skillsRoot?: string): string | null {
  if (!isPlainSegment(skillName)) return null;
  const skillFile = path.join(getSkillsRoot(skillsRoot), skillName, 'SKILL.md');
  try {
    return fs.readFileSync(skillFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read the content of a command's SKILL.md file (same source layout as skills,
 * and the same plain-segment rule on the name).
 */
export function readCommandContent(commandName: string, skillsRoot?: string): string | null {
  if (!isPlainSegment(commandName)) return null;
  const commandFile = path.join(getSkillsRoot(skillsRoot), commandName, 'SKILL.md');
  try {
    return fs.readFileSync(commandFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

