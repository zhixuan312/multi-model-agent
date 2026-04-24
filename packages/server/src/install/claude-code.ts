/**
 * Claude Code skill writer.
 *
 * Writes each skill's SKILL.md to `<homeDir>/.claude/skills/<skillName>/SKILL.md`.
 *
 * Before writing, inlines any `@include _shared/<file>.md` directives found in
 * the SKILL.md content. The directive line is replaced with the full content of
 * the corresponding shared file sourced from `<skillsRoot>/_shared/<file>.md`.
 * The `@include` directive is NOT preserved in the written file.
 *
 * If a referenced shared file is missing, a warning is logged to stderr but
 * the write continues (the include line is removed from the output).
 *
 * Security: Include paths must begin with `_shared/` and cannot traverse
 * outside the `_shared` directory. Skill names are validated to prevent
 * traversal outside the intended skills directory.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Options for installing a Claude Code skill.
 */
export interface ClaudeCodeInstallOpts {
  /** Skill name — used as the directory name under skills/. */
  skillName: string;
  /**
   * Raw SKILL.md content. May contain `@include _shared/<file>.md` directives
   * which are inlined before writing.
   */
  content: string;
  /**
   * The "home directory" that replaces `os.homedir()`.
   * Must NOT default to `os.homedir()` — always required explicitly.
   */
  homeDir: string;
  /**
   * Where shared files live. The writer reads `<skillsRoot>/_shared/<file>.md`
   * when inlining `@include` directives.
   */
  skillsRoot: string;
}

/**
 * Inline `@include _shared/<file>.md` directives in `content`.
 *
 * Each line matching `@include _shared/<path>` (space after `@include`) is
 * replaced with the full content of `<skillsRoot>/_shared/<path>`.
 *
 * Security constraints:
 * - Only paths beginning with `_shared/` are accepted.
 * - Path traversal (e.g., `../`) is rejected; the directive line is dropped.
 *
 * If a shared file is missing (ENOENT):
 * - A warning is written to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * @param content     Raw SKILL.md content (may contain @include directives).
 * @param skillsRoot  Root directory containing `_shared/` sub-directory.
 * @returns The content with directives inlined.
 */
export function inlineIncludes(content: string, skillsRoot: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Per-line matcher — no global regex, no stateful exec()
    const match = line.match(/^@include\s+(.+)$/);
    if (!match) {
      result.push(line);
      continue;
    }

    const relativePath = match[1] ?? '';

    // Security: only accept paths beginning with `_shared/`
    if (!relativePath.startsWith('_shared/')) {
      process.stderr.write(
        `Warning: Claude Code skill writer: @include path must start with ` +
        `"_shared/": ${relativePath}\n`,
      );
      continue;
    }

    // Security: reject path traversal attempts
    const resolvedPath = path.resolve(skillsRoot, relativePath);
    const sharedDir = path.resolve(skillsRoot, '_shared');
    if (!resolvedPath.startsWith(sharedDir + path.sep) &&
        resolvedPath !== sharedDir) {
      process.stderr.write(
        `Warning: Claude Code skill writer: @include path rejected (path ` +
        `traversal): ${relativePath}\n`,
      );
      continue;
    }

    const sharedFilePath = path.join(skillsRoot, relativePath);

    try {
      const sharedContent = fs.readFileSync(sharedFilePath, 'utf-8');
      result.push(sharedContent);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `Warning: Claude Code skill writer: shared file not found: ` +
          `${sharedFilePath} (referenced by @include ${relativePath}) — ${detail}\n`,
        );
      } else {
        // Other errors (permission, EISDIR, etc.) — re-throw to surface real issues
        throw err;
      }
      // Line is dropped — do not push anything.
    }
  }

  return result.join('\n');
}

/**
 * Validate that a skill name does not contain path traversal elements.
 *
 * @param skillName - The skill name to validate.
 * @throws If skillName contains `..` or absolute path elements.
 */
function validateSkillName(skillName: string): void {
  if (skillName.includes('..') || path.isAbsolute(skillName) || skillName.startsWith('/')) {
    throw new Error(`Invalid skill name: "${skillName}" — path traversal not allowed`);
  }
}

/**
 * Install a skill's SKILL.md to the Claude Code skills directory.
 *
 * - Creates `<homeDir>/.claude/skills/<skillName>/` if it does not exist.
 * - Inlines `@include` directives before writing (see `inlineIncludes`).
 * - Writes the final content to `<homeDir>/.claude/skills/<skillName>/SKILL.md`.
 *
 * @param opts  Installation options (see `ClaudeCodeInstallOpts`).
 */
export function installClaudeCode(opts: ClaudeCodeInstallOpts): void {
  const { skillName, content, homeDir, skillsRoot } = opts;

  // Security: validate skill name
  validateSkillName(skillName);

  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });

  const finalContent = inlineIncludes(content, skillsRoot);
  const destPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(destPath, finalContent, 'utf-8');
}

/**
 * Uninstall a skill from the Claude Code skills directory.
 *
 * Recursively removes `<homeDir>/.claude/skills/<skillName>/`.
 * This is a no-op when the directory does not exist (no error is thrown).
 *
 * @param skillName  Name of the skill directory to remove.
 * @param homeDir    The "home directory" that replaces `os.homedir()`.
 */
export function uninstallClaudeCode(skillName: string, homeDir: string): void {
  // Security: validate skill name
  validateSkillName(skillName);

  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  // rmSync with force:true handles nonexistence safely — no pre-check needed
  fs.rmSync(skillDir, { recursive: true, force: true });
}
