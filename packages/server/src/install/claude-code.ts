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

/** Regex matching a line that starts with `@include ` followed by a relative path. */
const INCLUDE_RE = /^@include\s+(.+)$/;

/**
 * Inline `@include _shared/<file>.md` directives in `content`.
 *
 * Each line matching `@include _shared/<path>` (space after `@include`) is
 * replaced with the full content of `<skillsRoot>/_shared/<path>`.
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
function inlineIncludes(content: string, skillsRoot: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }

    const relativePath = match[1]!;
    const sharedFilePath = path.join(skillsRoot, relativePath);

    try {
      const sharedContent = fs.readFileSync(sharedFilePath, 'utf-8');
      result.push(sharedContent);
    } catch (err) {
      // Log warning to stderr and drop the include line.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Warning: Claude Code skill writer: shared file not found: ` +
        `${sharedFilePath} (referenced by @include ${relativePath}) — ${detail}\n`,
      );
      // Line is dropped — do not push anything.
    }
  }

  return result.join('\n');
}

/**
 * Validate that the resolved skill directory stays within the intended skills root.
 *
 * This uses path resolution to ensure the skill name cannot escape the
 * `<homeDir>/.claude/skills/` directory via traversal components.
 *
 * @param skillName - The skill name to validate.
 * @param homeDir   - The home directory to resolve under.
 * @throws If the resolved path escapes the skills directory.
 */
function validateSkillName(skillName: string, homeDir: string): void {
  const skillsRoot = path.join(homeDir, '.claude', 'skills');
  const resolved = path.resolve(skillsRoot, skillName);
  const normalizedRoot = path.normalize(skillsRoot);

  // Ensure the resolved path is under the skills root
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(
      `Invalid skill name: "${skillName}" — path would resolve outside skills directory`,
    );
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

  // Security: validate skill name using path-based check
  validateSkillName(skillName, homeDir);

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
  // Security: validate skill name using path-based check
  validateSkillName(skillName, homeDir);

  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  // rmSync with force:true handles nonexistence safely — no pre-check needed
  fs.rmSync(skillDir, { recursive: true, force: true });
}