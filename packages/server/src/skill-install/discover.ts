// Skill discovery — locates packaged SKILL.md files on disk and reads them.
// Extracted from cli/install-skill.ts as part of Ch 7 Task 39.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from './manifest.js';
import { EMBEDDED_SKILLS } from './embedded-skills.js';

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

// Discover.ts lives in `packages/core/src/tool-surface/` (or its dist mirror).
// Skills are bundled by the server package at `packages/server/src/skills/`
// (copied to `packages/server/dist/skills/` at build time, then shipped on
// the `@zhixuan92/multi-model-agent` npm package as `dist/skills/`).
// Probe candidates for both monorepo dev layouts and the two npm-installed
// layouts (hoisted siblings, or core nested under server).
//
// Exported (and parameterized on `here` + `exists`) so the candidate logic
// can be unit-tested against fixtures that mimic each layout — the v4.0.1
// regression was a missing prod candidate.
export function skillsRootCandidates(here: string): string[] {
  return [
    // Dev source: packages/core/src/tool-surface -> packages/server/src/skills
    path.resolve(here, '..', '..', '..', 'server', 'src', 'skills'),
    // Dev built: packages/core/dist/tool-surface -> packages/server/dist/skills
    path.resolve(here, '..', '..', '..', 'server', 'dist', 'skills'),
    // npm install (hoisted): node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface
    //                     -> node_modules/@zhixuan92/multi-model-agent/dist/skills
    path.resolve(here, '..', '..', '..', 'multi-model-agent', 'dist', 'skills'),
    // npm install (core nested under server):
    //   .../multi-model-agent/node_modules/@zhixuan92/multi-model-agent-core/dist/tool-surface
    // -> .../multi-model-agent/dist/skills
    path.resolve(here, '..', '..', '..', '..', '..', 'dist', 'skills'),
    // Last-resort fallback for any caller that bundles skills inside core.
    path.resolve(here, '..', 'skills'),
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Compiled-binary fallback: dist/skills is not on disk inside a
      // `bun build --compile` binary, so consult the embedded assets.
      return EMBEDDED_SKILLS[`${skillName}/SKILL.md`] ?? null;
    }
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
