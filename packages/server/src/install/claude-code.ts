/**
 * Claude Code skill writer for install-skill.
 *
 * Writes each skill's SKILL.md to `<homeDir>/.claude/skills/<skillName>/SKILL.md`.
 *
 * Before writing, inlines any `@include _shared/<file>.md` directives found in
 * the content. The directive line is replaced with the full content of the
 * corresponding shared file sourced from `<skillsRoot>/_shared/<file>.md`.
 * The `@include` directive is NOT preserved in the written file.
 *
 * If a referenced shared file is missing (ENOENT):
 * - A warning is logged to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining content.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

import { inlineIncludes } from './include-utils.js';

/**
 * Options for installing a Claude Code skill.
 */
export interface ClaudeCodeInstallOpts {
  /** Human-readable name of the skill (used in file path). */
  skillName: string;
  /**
   * Raw skill content. May contain `@include _shared/<file>.md` directives
   * which are inlined before writing.
   */
  content: string;
  /**
   * Home directory — replaces `os.homedir()` in all file operations.
   * Must NOT default to `os.homedir()`.
   */
  homeDir: string;
  /** Root of the skills directory for @include resolution. */
  skillsRoot: string;
}

/**
 * Write (or overwrite) the SKILL.md file for a Claude Code skill.
 *
 * Target path: `<homeDir>/.claude/skills/<skillName>/SKILL.md`
 *
 * @param opts  Installation options (see `ClaudeCodeInstallOpts`).
 */
export function installClaudeCode(opts: ClaudeCodeInstallOpts): void {
  const { skillName, content, homeDir, skillsRoot } = opts;

  // Inline @include directives before writing
  const inlinedContent = inlineIncludes('Claude Code skill writer', content, skillsRoot);

  // Determine target path: <homeDir>/.claude/skills/<skillName>/SKILL.md
  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), inlinedContent, 'utf-8');
}

/**
 * Uninstall a Claude Code skill by removing its directory.
 *
 * Target: `<homeDir>/.claude/skills/<skillName>/`
 *
 * Security: `skillName` is validated against the expected skills directory
 * boundary to prevent path traversal (e.g. `../other-dir`). If `skillName`
 * resolves outside the skills directory, the function is a no-op.
 *
 * This is also a no-op when the directory does not exist (no error is thrown).
 *
 * @param skillName  Name of the skill to uninstall.
 * @param homeDir    Home directory where the skill directory lives.
 */
export function uninstallClaudeCode(skillName: string, homeDir: string): void {
  const skillsBase = path.resolve(homeDir, '.claude', 'skills');

  // Security: validate skillName does not escape the skills directory.
  // Normalize skillName and verify the resolved path stays within the base.
  const normalizedName = path.normalize(skillName);
  const resolvedSkillDir = path.resolve(skillsBase, normalizedName);
  const baseResolved = skillsBase + path.sep;
  if (!resolvedSkillDir.startsWith(baseResolved)) {
    // skillName traversal attempt — no-op rather than throwing, matching
    // the "no error when directory does not exist" behaviour.
    return;
  }

  fs.rmSync(resolvedSkillDir, { recursive: true, force: true });
}