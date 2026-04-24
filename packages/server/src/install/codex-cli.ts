/**
 * Codex CLI skill writer for install-skill.
 *
 * Task 9.7 scope: write/install and remove/uninstall of skills to
 * the Codex CLI's managed block in `<homeDir>/.codex/AGENTS.md`.
 *
 * Managed block delimiters:
 *   <!-- multi-model-agent:BEGIN -->
 *   ... skill content ...
 *   <!-- multi-model-agent:END -->
 *
 * Install behaviour:
 *   - If AGENTS.md does NOT exist: create it with just the managed block.
 *   - If AGENTS.md exists but has NO managed block markers: append the block
 *     at the end with a blank-line separator.
 *   - If AGENTS.md exists WITH managed block markers: replace the content
 *     between (and including) the markers with the new managed block.
 *   - User content OUTSIDE the markers is preserved verbatim.
 *
 * Uninstall behaviour:
 *   - Remove the managed block (including markers) from AGENTS.md.
 *   - If the file becomes empty or only whitespace after removal, delete the
 *     file.
 *   - If the file does not contain the markers, do nothing (no error).
 *   - If the file does not exist, do nothing (no error).
 *
 * @include resolution:
 *   Lines beginning with `@include _shared/<file>.md` are replaced with the
 *   file content read from `<skillsRoot>/_shared/<file>.md`.  If the file
 *   cannot be read, a warning is written to stderr and the line is omitted
 *   from the output (the directive is NOT preserved — matching the Claude Code
 *   writer behaviour).
 *
 * Security: @include paths must begin with `_shared/` and are resolved
 * strictly within `<skillsRoot>/_shared/` to prevent path traversal.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

const MANAGED_BEGIN = '<!-- multi-model-agent:BEGIN -->';
const MANAGED_END = '<!-- multi-model-agent:END -->';

// ─── Public types ────────────────────────────────────────────────────────────

export interface CodexCliInstallOpts {
  /** Human-readable name of the skill (used in warning messages). */
  skillName: string;
  /** Raw skill content (may contain @include directives). */
  content: string;
  /**
   * Home directory — replaces `os.homedir()` in all file operations.
   * Must NOT default to `os.homedir()`.
   */
  homeDir: string;
  /** Root of the skills directory for @include resolution. */
  skillsRoot: string;
}

// ─── Managed block helpers ────────────────────────────────────────────────────

/**
 * Build the complete managed block string including delimiters.
 *
 * Block format:
 *   <!-- multi-model-agent:BEGIN -->
 *   <content>
 *   <!-- multi-model-agent:END -->
 *
 * Key newline rules:
 * - BEGIN is always followed by `\n` so content starts on its own line.
 * - The content line(s) end with a newline. If content doesn't already end
 *   with `\n`, we add one before END.
 * - END is the final line of the block; no trailing newline is added after
 *   END (the block ends with the `>` character of the END tag).
 *
 * This means the block always ends with `MANAGED_END` as the last characters
 * of the file (no trailing newline after it).
 */
function buildManagedBlock(inlinedContent: string): string {
  const contentEndsWithNewline = inlinedContent.endsWith('\n');
  // Block format: BEGIN + "\n" + content (ending with \n) + END
  // No trailing newline after END — callers join suffix directly.
  return `${MANAGED_BEGIN}\n${inlinedContent}${contentEndsWithNewline ? '' : '\n'}${MANAGED_END}`;
}

// ─── @include inlining (private) ─────────────────────────────────────────────

/**
 * Inline `@include _shared/<path>` directives in `content`.
 *
 * Each line matching `@include _shared/<path>` is replaced with the full
 * content of the corresponding file under `<skillsRoot>/_shared/<path>`.
 *
 * Security constraints:
 * - Only paths beginning with `_shared/` are accepted.
 * - The resolved path must stay within `<skillsRoot>/_shared/`.  Path
 *   traversal attempts (e.g. `_shared/../secrets.txt`) are rejected with a
 *   warning and the directive line is dropped.
 *
 * Missing shared files:
 * - A warning containing "missing shared file" is written to stderr.
 * - The directive line is dropped (not preserved) — matching the Claude
 *   Code writer behaviour as required by the brief.
 *
 * @param skillName  Used in warning messages to identify the skill.
 * @param content    Raw skill content (may contain @include directives).
 * @param skillsRoot Root directory containing `_shared/`.
 * @returns The content with directives inlined.
 */
function inlineIncludes(
  skillName: string,
  content: string,
  skillsRoot: string,
): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@include\s+(.+)$/);
    if (!match) {
      result.push(line);
      continue;
    }

    // Trim trailing whitespace from the path token.
    const relativePath = match[1]!.trimEnd();

    // Security: only accept paths beginning with `_shared/`
    if (!relativePath.startsWith('_shared/')) {
      process.stderr.write(
        `Warning: Codex CLI skill writer [${skillName}]: @include path must ` +
        `start with "_shared/": ${relativePath}\n`,
      );
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
        `Warning: Codex CLI skill writer [${skillName}]: @include path ` +
        `rejected (path traversal): ${relativePath}\n`,
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
        process.stderr.write(
          `Warning: Codex CLI skill writer [${skillName}]: missing shared ` +
          `file: ${sharedFilePath} (referenced by @include ${relativePath})\n`,
        );
        // Directive is dropped — do not push anything.
      } else {
        // Permission errors, EISDIR, etc. — re-throw so the caller notices.
        throw err;
      }
    }
  }

  return result.join('\n');
}

// ─── Marker helpers ────────────────────────────────────────────────────────────

/**
 * Returns true only when both managed block markers are present in
 * `content` and BEGIN appears before END.  An orphan marker or corrupt
 * ordering does NOT constitute a valid block.
 */
function hasManagedBlock(content: string): boolean {
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  return beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx;
}

// ─── Core write logic ─────────────────────────────────────────────────────────

/**
 * Find the span of the existing managed block (including both markers) in
 * `content`.  Returns `{ prefix, suffix }` where `prefix` is everything
 * before BEGIN and `suffix` is everything after the block's final character.
 *
 * The block always ends with `MANAGED_END` (no trailing newline after END).
 * After END, there may be a structural newline (the newline that terminates
 * the END line). This structural newline is NOT part of the user suffix — it
 * belongs to the block boundary and must not appear as an extra blank line
 * when prefix and suffix are joined.
 *
 * Edge cases:
 * - If END is the last character of the file (no trailing newline), suffix
 *   is empty.
 * - If BEGIN and END are in corrupt order (END before BEGIN), returns null
 *   so no user content is inadvertently destroyed.
 */
function splitAroundBlock(
  content: string,
): { prefix: string; suffix: string } | null {
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);

  // No valid block without both markers
  if (beginIdx === -1 || endIdx === -1) {
    return null;
  }

  // Corrupt order: END before BEGIN — treat as no valid block to protect
  // user content from inadvertent removal.
  if (beginIdx > endIdx) {
    return null;
  }

  // suffix starts immediately after MANAGED_END (includes any trailing newlines).
  // Callers decide how to handle the leading newlines in suffix:
  //   - Install (replace): suffix begins with the separator between END and
  //     following user content; joining block + suffix reconstructs the file.
  //   - Uninstall: strip all leading newlines from suffix before joining.
  const suffixStart = endIdx + MANAGED_END.length;

  return {
    prefix: content.slice(0, beginIdx),
    suffix: content.slice(suffixStart),
  };
}

/**
 * Write (or overwrite) the managed block in the Codex CLI's AGENTS.md.
 *
 * The algorithm:
 *   1. Inline @include directives.
 *   2. Read existing file if present.
 *   3. Determine new content: create / append / replace.
 *   4. Write to disk.
 *
 * @throws If the AGENTS.md file exists but cannot be read.
 * @throws If the AGENTS.md path is a directory.
 */
export function installCodexCli(opts: CodexCliInstallOpts): void {
  const agentsPath = path.join(opts.homeDir, '.codex', 'AGENTS.md');

  // 1. Inline @include directives
  const inlinedContent = inlineIncludes(
    opts.skillName,
    opts.content,
    opts.skillsRoot,
  );
  const block = buildManagedBlock(inlinedContent);

  // 2. Read existing file
  let existingContent: string;
  let fileExists = false;
  try {
    const stat = fs.statSync(agentsPath);
    if (stat.isDirectory()) {
      throw new Error(`AGENTS.md path is a directory: ${agentsPath}`);
    }
    existingContent = fs.readFileSync(agentsPath, 'utf-8');
    fileExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      existingContent = '';
      fileExists = false;
    } else {
      throw err;
    }
  }

  // 3. Determine new content
  let newContent: string;
  if (!fileExists) {
    // Case A: file does not exist → create with just the managed block
    newContent = block;
  } else if (!hasManagedBlock(existingContent)) {
    // Case B: file exists but no managed block → append with blank-line separator
    //
    // The block begins with BEGIN + "\n". To create exactly one blank line
    // between existing content and the BEGIN marker:
    //   - If existingContent ends with "\n": add one "\n" → existing ends with
    //     "\n", block starts with "\n" → two newlines = one blank line. ✓
    //   - If existingContent does NOT end with "\n": add "\n\n" → existing ends
    //     with "\n", block starts with "\n" → two newlines = one blank line. ✓
    newContent = existingContent.endsWith('\n')
      ? `${existingContent}\n${block}`
      : `${existingContent}\n\n${block}`;
  } else {
    // Case C: file exists with managed block → replace it
    const split = splitAroundBlock(existingContent);
    if (split === null) {
      // Both markers present but split returned null — corrupt marker order.
      // Do not overwrite; append with separator instead.
      newContent = existingContent.endsWith('\n')
        ? `${existingContent}\n${block}`
        : `${existingContent}\n\n${block}`;
    } else {
      const { prefix, suffix } = split;
      newContent = `${prefix}${block}${suffix}`;
    }
  }

  // 4. Write to disk
  fs.mkdirSync(path.join(opts.homeDir, '.codex'), { recursive: true });
  fs.writeFileSync(agentsPath, newContent, 'utf-8');
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Remove the managed block (including markers) from AGENTS.md.
 *
 * Behaviour:
 *   - File does not exist → no-op.
 *   - File has no managed block markers → no-op (file unchanged).
 *   - File has managed block → remove it; write remaining content back.
 *   - Remaining content is empty or whitespace-only → delete the file.
 *
 * @throws On filesystem errors other than ENOENT when reading/writing.
 */
export function uninstallCodexCli(homeDir: string): void {
  const agentsPath = path.join(homeDir, '.codex', 'AGENTS.md');

  let content: string;
  try {
    content = fs.readFileSync(agentsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File does not exist — no-op.
      return;
    }
    // Re-throw on read errors, preserving the original error context.
    throw err;
  }

  if (!hasManagedBlock(content)) {
    // No managed block to remove — file unchanged.
    return;
  }

  const split = splitAroundBlock(content);
  if (split === null) {
    // Both markers present but split returned null — corrupt marker order.
    // No safe block to remove — leave file unchanged.
    return;
  }

  const { prefix, suffix } = split;
  // Strip all leading newlines from suffix. The suffix begins with any
  // newlines that followed MANAGED_END (including blank-line separators).
  // Removing them avoids leaving orphan blank lines after the managed block
  // is gone. The prefix already ends before BEGIN (including any trailing
  // newlines the user placed before the block), so this does not disturb
  // user-authored spacing in the prefix.
  const trimmedSuffix = suffix.replace(/^\n+/, '');
  const newContent = `${prefix}${trimmedSuffix}`;

  if (newContent.trim() === '') {
    // File is empty after removal — delete it.
    fs.unlinkSync(agentsPath);
  } else {
    fs.writeFileSync(agentsPath, newContent, 'utf-8');
  }
}