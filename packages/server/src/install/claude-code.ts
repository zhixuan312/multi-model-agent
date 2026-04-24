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
  const inlinedContent = inlineIncludes(content, skillsRoot);

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
 * This is a no-op when the directory does not exist (no error is thrown).
 *
 * @param skillName  Name of the skill to uninstall.
 * @param homeDir    Home directory where the skill directory lives.
 */
export function uninstallClaudeCode(skillName: string, homeDir: string): void {
  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  fs.rmSync(skillDir, { recursive: true, force: true });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Regex matching a line that starts with `@include ` (exact space after
 * `@include`) followed by a relative path.
 */
const INCLUDE_RE = /^@include\s+(.+)$/;

/**
 * Inline `@include _shared/<path>` directives in `content`.
 *
 * Each line matching `@include _shared/<path>` (space after `@include`) is
 * replaced with the full content of `<skillsRoot>/_shared/<path>`.
 *
 * If a shared file is missing (ENOENT):
 * - A warning is written to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * @param content     Raw skill content (may contain @include directives).
 * @param skillsRoot  Root directory containing `_shared/` sub-directory.
 * @returns The content with directives inlined.
 */
function inlineIncludes(content: string, skillsRoot: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }

    const relativePath = match[1] ?? '';

    // Only accept paths beginning with `_shared/`
    if (!relativePath.startsWith('_shared/')) {
      process.stderr.write(
        `Warning: Claude Code skill writer: @include path must start with ` +
        `"_shared/": ${relativePath}\n`,
      );
      // Directive line is dropped — do not push anything.
      continue;
    }

    const sharedFilePath = path.join(skillsRoot, relativePath);

    try {
      const sharedContent = fs.readFileSync(sharedFilePath, 'utf-8');
      result.push(sharedContent);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        // Missing shared file — warn and drop the directive line.
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `Warning: Claude Code skill writer: shared file not found: ` +
          `${sharedFilePath} (referenced by @include ${relativePath}) — ${detail}\n`,
        );
        // Line is dropped — do not push anything.
      } else {
        // Permission errors, EISDIR, etc. — re-throw so the caller notices.
        throw err;
      }
    }
  }

  return result.join('\n');
}