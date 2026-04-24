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
 *   Lines matching `@include _shared/<file>.md` are replaced with the file
 *   content read from `<skillsRoot>/_shared/<file>.md`.  If the file cannot
 *   be read, a warning is written to stderr and the line is omitted from the
 *   output (the directive is NOT preserved — matching the Claude Code writer
 *   behaviour).
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

import { inlineIncludes } from './include-utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MANAGED_BEGIN = '<!-- multi-model-agent:BEGIN -->';
const MANAGED_END = '<!-- multi-model-agent:END -->';
const MANAGED_BEGIN_NL = MANAGED_BEGIN + '\n';
const MANAGED_END_NL = MANAGED_END + '\n';

// ─── Public types ────────────────────────────────────────────────────────────

export interface CodexCliInstallOpts {
  /**
   * Human-readable name of the skill (used in warning messages).
   */
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
 * The content is normalized to use LF (\n) line endings and the block always
 * ends with a newline before the END tag so that any following user content
 * starts on its own line.
 */
function buildManagedBlock(inlinedContent: string): string {
  // Normalize to LF for consistent file output regardless of input style.
  const lfContent = inlinedContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Ensure a trailing LF before END so that user suffix content (if any) is
  // on its own line after the END tag.
  const content =
    lfContent.endsWith('\n') ? lfContent : lfContent + '\n';
  return MANAGED_BEGIN_NL + content + MANAGED_END_NL;
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

/**
 * Find the span of the existing managed block (including both markers) in
 * `content`.  Returns `{ prefix, suffix }` where `prefix` is everything
 * before BEGIN and `suffix` is everything after the block's final line.
 *
 * The newline that terminates the END line (LF or CRLF) is treated as a
 * structural part of the block boundary and is NOT included in suffix.
 * This ensures no extra blank line is introduced between the END tag and
 * any user content that follows.
 *
 * Edge cases:
 * - END is the last character of the file (no trailing newline): suffix is
 *   empty.
 * - BEGIN and END are in corrupt order (END before BEGIN): returns null so
 *   no user content is inadvertently destroyed.
 */
function splitAroundBlock(
  content: string,
): { prefix: string; suffix: string } | null {
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);

  if (beginIdx === -1 || endIdx === -1) {
    return null;
  }

  if (beginIdx > endIdx) {
    // Corrupt order — treat as no valid block.
    return null;
  }

  const endAfterMarker = endIdx + MANAGED_END.length;

  // Strip the structural newline (LF or CRLF) that terminates the END line.
  // This newline belongs to the block boundary, not to user content.
  let suffixStart: number;
  if (content.slice(endAfterMarker, endAfterMarker + 2) === '\r\n') {
    suffixStart = endAfterMarker + 2;
  } else if (content[endAfterMarker] === '\n') {
    suffixStart = endAfterMarker + 1;
  } else {
    suffixStart = endAfterMarker;
  }

  return {
    prefix: content.slice(0, beginIdx),
    suffix: content.slice(suffixStart),
  };
}

// ─── Core write logic ─────────────────────────────────────────────────────────

/**
 * Write (or overwrite) the managed block in the Codex CLI's AGENTS.md.
 *
 * @throws If the AGENTS.md path is a directory.
 * @throws On filesystem errors other than ENOENT when reading/writing.
 */
export function installCodexCli(opts: CodexCliInstallOpts): void {
  const agentsPath = path.join(opts.homeDir, '.codex', 'AGENTS.md');

  // 1. Inline @include directives — use skillName for clear warning context.
  const inlinedContent = inlineIncludes(
    opts.skillName,
    opts.content,
    opts.skillsRoot,
  );
  const block = buildManagedBlock(inlinedContent);

  // 2. Read existing file (single read with ENOENT handling — no separate stat).
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

  // 3. Determine new content.
  let newContent: string;
  if (!fileExists) {
    // Case A: file does not exist → create with just the managed block.
    newContent = block;
  } else if (!hasManagedBlock(existingContent)) {
    // Case B: file exists but no managed block → append with one blank-line
    // separator.  The block begins with BEGIN + "\n".  Adding one "\n" before
    // the block gives exactly one blank line of separation from existing content.
    newContent = `${existingContent}\n${block}`;
  } else {
    // Case C: file exists with managed block → replace it.
    const split = splitAroundBlock(existingContent);
    if (split === null) {
      // Corrupt marker order — fall back to append.
      newContent = `${existingContent}\n${block}`;
    } else {
      const { prefix, suffix } = split;
      newContent = `${prefix}${block}${suffix}`;
    }
  }

  // 4. Write to disk.
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
    throw err;
  }

  if (!hasManagedBlock(content)) {
    // No managed block to remove — file unchanged.
    return;
  }

  const split = splitAroundBlock(content);
  if (split === null) {
    // Corrupt marker order — no safe block to remove.
    return;
  }

  const { prefix, suffix } = split;
  const newContent = `${prefix}${suffix}`;

  if (newContent.trim() === '') {
    // File is empty or whitespace-only after removal — delete it.
    fs.unlinkSync(agentsPath);
  } else {
    fs.writeFileSync(agentsPath, newContent, 'utf-8');
  }
}
