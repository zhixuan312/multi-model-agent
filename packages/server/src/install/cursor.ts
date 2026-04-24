/**
 * Cursor skill writer.
 *
 * Writes the skill content to `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 *
 * Before writing, inlines any `@include _shared/<file>.md` directives found in
 * the content. The directive line is replaced with the full content of
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

/** Regex matching a line that starts with `@include ` followed by a relative path. */
const INCLUDE_RE = /^@include\s+(.+)$/gm;

/**
 * Options for installing a Cursor skill.
 */
export interface CursorInstallOpts {
  /**
   * Raw skill content. May contain `@include _shared/<file>.md` directives
   * which are inlined before writing.
   */
  content: string;
  /**
   * Working directory — replaces `process.cwd()`.
   * Must NOT default to `process.cwd()` — always required explicitly.
   */
  cwd: string;
  /**
   * The "home directory" that replaces `os.homedir()`.
   * Must NOT default to `os.homedir()` — always required explicitly.
   */
  homeDir: string;
  /**
   * Where shared files live. The writer reads `<skillsRoot>/_shared/<path>`
   * when inlining `@include` directives.
   */
  skillsRoot: string;
  /**
   * If true, overwrite the existing file. If false (default), skip writing
   * when the file already exists.
   */
  force?: boolean;
}

/**
 * Result of `installCursor`.
 */
export interface CursorInstallResult {
  /**
   * `true` if the file was written, `false` if it was skipped because it
   * already exists and `force` was not set.
   */
  written: boolean;
  /** The full path that was (or would have been) written. */
  targetPath: string;
}

/**
 * Inline `@include _shared/<file>.md` directives in `content`.
 *
 * Each line matching `@include <path>` (space after `@include`) is replaced with
 * the full content of `<skillsRoot>/_shared/<path>`.
 *
 * If a shared file is missing:
 * - A warning is written to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * @param content     Raw skill content (may contain @include directives).
 * @param skillsRoot  Root directory containing `_shared/` sub-directory.
 * @returns The content with directives inlined.
 */
export function inlineIncludes(content: string, skillsRoot: string): string {
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
        `Warning: Cursor skill writer: shared file not found: ` +
        `${sharedFilePath} (referenced by @include ${relativePath}) — ${detail}\n`,
      );
      // Line is dropped — do not push anything.
    }
  }

  return result.join('\n');
}

/**
 * Install the multi-model-agent skill for Cursor.
 *
 * - Target path is `<cwd>/.cursor/rules/multi-model-agent.mdc` (CWD-relative).
 * - Creates `<cwd>/.cursor/rules/` if it does not exist.
 * - Inlines `@include` directives before writing (see `inlineIncludes`).
 * - If the file already exists and `force` is not set, skips writing and
 *   returns `written: false`.
 *
 * @param opts  Installation options (see `CursorInstallOpts`).
 */
export function installCursor(opts: CursorInstallOpts): CursorInstallResult {
  const { content, cwd, homeDir: _homeDir, skillsRoot, force } = opts;

  const targetPath = path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');

  if (!force && fs.existsSync(targetPath)) {
    process.stderr.write(
      `Warning: Cursor skill writer: file already exists: ${targetPath} — skipping (use force: true to overwrite)\n`,
    );
    return { written: false, targetPath };
  }

  const rulesDir = path.join(cwd, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });

  const finalContent = inlineIncludes(content, skillsRoot);
  fs.writeFileSync(targetPath, finalContent, 'utf-8');

  return { written: true, targetPath };
}

/**
 * Uninstall the multi-model-agent Cursor skill.
 *
 * Removes `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 * This is a no-op when the file does not exist (no error is thrown).
 *
 * @param cwd  Working directory (replaces `process.cwd()`).
 */
export function uninstallCursor(cwd: string): void {
  const targetPath = path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
}
