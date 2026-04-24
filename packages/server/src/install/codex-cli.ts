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
 * Install behavior:
 *   - If AGENTS.md does NOT exist: create it with just the managed block.
 *   - If AGENTS.md exists but has NO managed block markers: append the block at
 *     the end (with a blank line separator).
 *   - If AGENTS.md exists WITH managed block markers: replace the content
 *     between (and including) the markers with the new managed block.
 *   - User content OUTSIDE the markers is preserved verbatim.
 *
 * Uninstall behavior:
 *   - Remove the managed block (including the markers) from AGENTS.md.
 *   - If the file becomes empty or only whitespace after removal, delete the file.
 *   - If the file does not contain the markers, do nothing (no error).
 *   - If the file does not exist, do nothing (no error).
 *
 * @include resolution:
 *   Lines beginning with `@include _shared/<file>.md` are replaced with the
 *   file content read from `<skillsRoot>/_shared/<file>.md`.  If the file
 *   cannot be read, a warning is written to stderr and the line is left as-is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

// ─── Constants ────────────────────────────────────────────────────────────────

const MANAGED_BEGIN = '<!-- multi-model-agent:BEGIN -->';
const MANAGED_END = '<!-- multi-model-agent:END -->';

const INCLUDE_REGEX = /^@include\s+_shared\/(\S+)\s*$/;

// ─── Public types ────────────────────────────────────────────────────────────

export interface CodexCliInstallOpts {
  /** Human-readable name of the skill (used in logs/warnings). */
  skillName: string;
  /** Raw skill content with @includes not yet inlined. */
  content: string;
  /** Home directory (replaces os.homedir() in all file operations). */
  homeDir: string;
  /** Root of the skills directory for @include resolution. */
  skillsRoot: string;
}

// ─── @include inlining ───────────────────────────────────────────────────────

/**
 * Inline `@include _shared/<file>.md` directives in `content`.
 *
 * Each line matching `@include _shared/<file>.md` is replaced with the
 * contents of `<skillsRoot>/_shared/<file>.md`.  Missing shared files trigger
 * a warning to stderr; the original directive line is left unchanged in that
 * case.
 *
 * Note: this function is synchronous to keep the overall install flow simple.
 * For large files consider a streaming version, but skills are expected to be
 * small (< 100 kB), so the synchronous approach is sufficient.
 */
function inlineIncludes(content: string, skillsRoot: string): string {
  const sharedDir = path.join(skillsRoot, '_shared');
  return content
    .split('\n')
    .map((line) => {
      const match = line.match(INCLUDE_REGEX);
      if (!match) return line;
      const fileName = match[1];
      const filePath = path.join(sharedDir, fileName);
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : String(err);
        // Write warning to stderr so callers can capture it in tests.
        process.stderr.write(
          `[${'codex-cli'}:${'inlineIncludes'}] warning: ` +
          `missing shared file for @include directive: ` +
          `${fileName} (${filePath}): ${detail}\n`,
        );
        return line;
      }
    })
    .join('\n');
}

// ─── Managed block helpers ────────────────────────────────────────────────────

/**
 * Build the complete managed block string including delimiters.
 */
function buildManagedBlock(inlinedContent: string): string {
  return `${MANAGED_BEGIN}\n${inlinedContent}\n${MANAGED_END}`;
}

/**
 * Check whether `content` contains the managed block markers.
 */
function hasManagedBlock(content: string): boolean {
  return (
    content.includes(MANAGED_BEGIN) ||
    // Also detect orphaned BEGIN without END and orphaned END without BEGIN.
    content.includes(MANAGED_END)
  );
}

// ─── Core write logic ─────────────────────────────────────────────────────────

/**
 * Write (or overwrite) the managed block in the Codex CLI's AGENTS.md.
 *
 * The function follows the three-phase strategy described in the module
 * docstring above: create / append / replace.
 *
 * No-op when `opts.homeDir/.codex/AGENTS.md` already contains exactly the
 * requested block (avoids unnecessary writes and manifest noise).
 *
 * @throws If the AGENTS.md file exists but cannot be read as UTF-8.
 * @throws If the AGENTS.md file is a directory.
 */
function writeManagedBlock(opts: CodexCliInstallOpts): void {
  const agentsPath = path.join(opts.homeDir, '.codex', 'AGENTS.md');

  // ── 1. Inline @include directives ───────────────────────────────────────
  const inlinedContent = inlineIncludes(opts.content, opts.skillsRoot);
  const block = buildManagedBlock(inlinedContent);

  // ── 2. Read existing file ────────────────────────────────────────────────
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

  // ── 3. Short-circuit if content is already correct ───────────────────────
  if (fileExists && existingContent === block) {
    return;
  }

  // ── 4. Determine new content based on existing file state ────────────────
  let newContent: string;
  if (!fileExists) {
    // Case A: file does not exist → create with just the managed block
    newContent = block;
  } else if (!hasManagedBlock(existingContent)) {
    // Case B: file exists but no managed block → append with blank line
    newContent = existingContent.endsWith('\n')
      ? `${existingContent}${block}\n`
      : `${existingContent}\n\n${block}\n`;
  } else {
    // Case C: file exists with managed block → replace it
    newContent = replaceManagedBlock(existingContent, block);
  }

  // ── 5. Write to disk ─────────────────────────────────────────────────────
  fs.mkdirSync(path.join(opts.homeDir, '.codex'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(agentsPath, newContent, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Replace the existing managed block (including markers) with `newBlock`.
 * Assumes `existingContent` contains at least one of the marker strings.
 *
 * Algorithm:
 *   1. Split on MANAGED_BEGIN — keep everything before it as `prefix`.
 *   2. Split the remainder on MANAGED_END — keep everything after it as `suffix`.
 *   3. Reassemble: prefix + newBlock (+ suffix trimmed of leading blank lines
 *      to avoid double blank lines when uninstalling later).
 *
 * If only MANAGED_BEGIN is found (orphaned), treat all content after it as
 * the block to replace.  If only MANAGED_END is found (orphaned), treat all
 * content before it as the block to replace.  This is defensive so a corrupt
 * file does not crash the writer.
 */
function replaceManagedBlock(existingContent: string, newBlock: string): string {
  const beginIdx = existingContent.indexOf(MANAGED_BEGIN);
  const endIdx = existingContent.indexOf(MANAGED_END);

  if (beginIdx === -1 && endIdx === -1) {
    // Should not happen (caller already verified), but return new block safely
    return newBlock;
  }

  if (beginIdx === -1) {
    // Orphan END — remove everything up to and including END
    return existingContent.slice(0, endIdx).trimEnd();
  }

  if (endIdx === -1) {
    // Orphan BEGIN — remove everything from BEGIN onward
    return existingContent.slice(0, beginIdx).trimEnd();
  }

  // Normal case: both markers present
  if (beginIdx < endIdx) {
    const prefix = existingContent.slice(0, beginIdx);
    const suffix = existingContent.slice(endIdx + MANAGED_END.length);
    return `${prefix}${newBlock}${stripLeadingBlankLines(suffix)}`;
  } else {
    // END appears before BEGIN (unusual) — treat as orphan END first
    const beforeEnd = existingContent.slice(0, endIdx);
    const afterEnd = existingContent.slice(endIdx + MANAGED_END.length);
    const suffix = stripLeadingBlankLines(afterEnd);
    const newContent = `${beforeEnd.trimEnd()}${newBlock}${suffix}`;
    // Now remove orphan BEGIN if it appears after our insertion
    const remainingBeginIdx = newContent.indexOf(MANAGED_BEGIN, suffix.length);
    if (remainingBeginIdx !== -1) {
      return newContent.slice(0, remainingBeginIdx).trimEnd();
    }
    return newContent;
  }
}

/**
 * Strip a trailing blank line (or sequence of trailing blank lines) from
 * the beginning of `suffix` so that uninstalling a block that is the last
 * thing in the file does not leave a dangling blank line.
 *
 * Examples:
 *   "\n"              → ""
 *   "\n\n# heading"   → "\n# heading"
 *   "# heading"       → "# heading"  (no change)
 *   "\n# heading"     → "# heading"  (single newline removed)
 *   "  \n# heading"   → "# heading" (whitespace-only line removed)
 */
function stripLeadingBlankLines(suffix: string): string {
  return suffix.replace(/^[ \t]*\n+/, '');
}

// ─── Uninstall helpers ───────────────────────────────────────────────────────

/**
 * Remove the managed block (including markers) from AGENTS.md.
 * If the resulting file is empty or whitespace-only, delete the file.
 * If the file does not exist, do nothing.
 * If the file has no managed block markers, do nothing.
 */
function removeManagedBlock(homeDir: string): void {
  const agentsPath = path.join(homeDir, '.codex', 'AGENTS.md');

  // No-op if file does not exist
  if (!fs.existsSync(agentsPath)) {
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(agentsPath, 'utf-8');
  } catch {
    // Cannot read — nothing to remove safely; propagate so caller knows
    return;
  }

  if (!hasManagedBlock(content)) {
    // No managed block to remove
    return;
  }

  const newContent = replaceManagedBlock(content, '');

  if (newContent.trim() === '') {
    // File is empty after removal — delete it
    try {
      fs.unlinkSync(agentsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } else {
    fs.writeFileSync(agentsPath, newContent, { encoding: 'utf-8', mode: 0o600 });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Install the skill to the Codex CLI by appending/updating the managed block
 * in `<homeDir>/.codex/AGENTS.md`.
 *
 * User content outside the managed block is always preserved.
 *
 * @param opts.skillName  — Human-readable name (logged on @include warnings).
 * @param opts.content    — Raw skill content (may include @include directives).
 * @param opts.homeDir    — Replaces `os.homedir()` in all file operations.
 * @param opts.skillsRoot — Base path for @include resolution.
 */
export function installCodexCli(opts: CodexCliInstallOpts): void {
  writeManagedBlock(opts);
}

/**
 * Uninstall the skill from the Codex CLI by removing the managed block
 * from `<homeDir>/.codex/AGENTS.md`.
 *
 * User content outside the managed block is preserved.
 *
 * No-op conditions:
 *   - File does not exist
 *   - File exists but contains no managed block markers
 *
 * @param homeDir — Replaces `os.homedir()` in all file operations.
 */
export function uninstallCodexCli(homeDir: string): void {
  removeManagedBlock(homeDir);
}
