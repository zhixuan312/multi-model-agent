/**
 * Shared include-inlining utilities for skill writers.
 *
 * Provides a common implementation for `@include _shared/<path>` directive
 * processing, used by all skill writers (Claude Code, Cursor, etc.).
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

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
 * Security constraints:
 * - Only paths beginning with `_shared/` are accepted.
 * - The resolved path must stay within `<skillsRoot>/_shared/`.
 *   Path traversal attempts are rejected with a warning and the directive
 *   line is dropped.
 *
 * If a shared file is missing (ENOENT):
 * - A warning is written to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * Other I/O errors (permission denied, EISDIR, etc.) are re-thrown so the
 * caller can distinguish them from a simple missing-file case.
 *
 * @param skillContext  Used in warning messages to identify the skill context.
 * @param content       Raw skill content (may contain @include directives).
 * @param skillsRoot    Root directory containing `_shared/` sub-directory.
 * @returns The content with directives inlined.
 */
export function inlineIncludes(
  skillContext: string,
  content: string,
  skillsRoot: string,
): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }

    const relativePath = match[1] ?? '';

    // Security: only accept paths beginning with `_shared/`
    if (!relativePath.startsWith('_shared/')) {
      process.stderr.write(
        `Warning: ${skillContext}: @include path must start with ` +
        `"_shared/": ${relativePath}\n`,
      );
      // Directive line is dropped — do not push anything.
      continue;
    }

    // Security: reject path traversal attempts
    const resolvedPath = path.resolve(skillsRoot, relativePath);
    const sharedDir = path.resolve(skillsRoot, '_shared');
    if (
      !resolvedPath.startsWith(sharedDir + path.sep) &&
      resolvedPath !== sharedDir
    ) {
      process.stderr.write(
        `Warning: ${skillContext}: @include path rejected ` +
        `(path traversal): ${relativePath}\n`,
      );
      // Directive line is dropped.
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
          `Warning: ${skillContext}: shared file not found: ` +
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