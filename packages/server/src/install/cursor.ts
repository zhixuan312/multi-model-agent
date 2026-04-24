/**
 * Cursor skill writer.
 *
 * Writes the skill content to `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 *
 * Before writing, inlines any `@include _shared/<file>.md` directives found in
 * the content. The directive line is replaced with the full content of
 * the corresponding shared file sourced from `<skillsRoot>/_shared/<path>`.
 * The `@include` directive is NOT preserved in the written file.
 *
 * If a referenced shared file is missing (ENOENT):
 * - A warning is logged to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * Security constraints on `@include` directives:
 * - Only paths beginning with `_shared/` are accepted.
 * - The resolved path must stay within `<skillsRoot>/_shared/`.
 *   Path traversal attempts (e.g. `_shared/../secrets.txt`) are rejected
 *   with a warning and the directive line is dropped.
 * - Non-`_shared/` paths are rejected with a warning and the directive
 *   line is dropped.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

import { inlineIncludes } from './include-utils.js';

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
   * Required by the API for signature compatibility, but not used by
   * the Cursor writer (target is CWD-relative, not home-relative).
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
  const { content, cwd, skillsRoot, force } = opts;

  const targetPath = path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');

  if (!force && fs.existsSync(targetPath)) {
    process.stderr.write(
      `Warning: Cursor skill writer: file already exists: ${targetPath} — skipping (use force: true to overwrite)\n`,
    );
    return { written: false, targetPath };
  }

  const rulesDir = path.join(cwd, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });

  const finalContent = inlineIncludes('Cursor skill writer', content, skillsRoot);
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

  // Only remove the file if it exists and is a file (not a directory).
  // This is a no-op when the path does not exist.
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      fs.unlinkSync(targetPath);
    }
    // If it's a directory or symlink to directory, do nothing — the brief
    // specifies removing a file, not a directory tree.
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    // ENOENT means the file doesn't exist — that's fine, we were asked to remove it
    if (nodeErr.code !== 'ENOENT') {
      throw err;
    }
  }
}
