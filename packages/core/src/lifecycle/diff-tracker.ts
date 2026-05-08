/**
 * DiffTracker — snapshot files at task start, produce a cumulative
 * unified diff at any point during the lifecycle.
 *
 * Tool sweep #6 motivation: every reviewer template (spec / quality /
 * diff) was reviewing the worker's TEXT CLAIM about its work, not the
 * actual change on disk. Result:
 *   - Spec reviewers defaulted to "changes_required" because they
 *     could not verify a claim they couldn't see → endless rework
 *     spirals on already-correct work.
 *   - Quality findings were rooted in the worker's prose summary
 *     rather than diff lines → false positives, missed regressions.
 *   - The "diff reviewer" did not actually receive a diff (a misnomer).
 *
 * Fix: every reviewer prompt now receives `cumulativeDiff` — the
 * unified diff of every change made since task start, regardless of
 * which rework round produced it. With evidence in hand the reviewer
 * can be precise: "diff matches brief? approve" — single round, no
 * spiral, no waste.
 *
 * "Cumulative" matters: across spec_rework rounds 1..N, the reviewer
 * needs to see the totality of edits so it can confirm prior reworks'
 * additions are still present. A latest-round-only diff would make
 * the round-2 reviewer say "you didn't add Y" when round-1 actually
 * did.
 *
 * Implementation choice: snapshot-based, NOT git-based.
 *   - Works in non-git directories (test fixtures, sandboxes,
 *     fresh-scaffold projects).
 *   - No assumption about HEAD state.
 *   - No mutation of `.git/` (no `add -N`, no temporary index entries).
 *   - Captures new files cleanly (baseline=null → full new-file diff).
 *
 * Diff format: unified diff (`@@ -before,count +after,count @@`)
 * generated via Myers-style line LCS. The LLM is the consumer; the
 * format is what every model has been trained on.
 *
 * Output cap: 50KB total. Excess is truncated with a "[diff truncated
 * at 50KB — N more bytes elided]" marker so the LLM knows the diff is
 * incomplete and can react accordingly (rather than silently judging
 * a partial picture).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_DIFF_BYTES = 50 * 1024; // 50KB cap to protect reviewer context window
const CONTEXT_LINES = 3;          // unified-diff convention

/** Snapshot of a single file at task-start time. `null` means the
 *  file did not exist (so a worker-created file diffs as a full add). */
type Baseline = string | null;

export class DiffTracker {
  private baselines = new Map<string, Baseline>();

  constructor(private cwd: string) {}

  /**
   * Capture current file content as the baseline. Idempotent: if a
   * path was already snapshotted, the existing baseline wins (the
   * earliest-known content is the canonical pre-task state).
   *
   * Call once at task start with all `task.filePaths`; call again
   * lazily (via `ensureSnapshotted`) if a worker writes a path that
   * wasn't pre-declared.
   */
  async snapshot(relativePaths: ReadonlyArray<string>): Promise<void> {
    for (const rel of relativePaths) {
      if (this.baselines.has(rel)) continue;
      const abs = path.resolve(this.cwd, rel);
      try {
        const content = await fs.readFile(abs, 'utf-8');
        this.baselines.set(rel, content);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          // File didn't exist at task start. Worker may create it →
          // diff later will show as a full new-file diff.
          this.baselines.set(rel, null);
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Defensive: if the worker writes a file that wasn't pre-declared
   * in `task.filePaths`, we don't have a baseline for it. Capture
   * one NOW (whatever the file's current state) so subsequent diffs
   * show only what THIS rework round changed for it. This is a
   * best-effort fallback; the operator should declare filePaths.
   */
  async ensureSnapshotted(relativePath: string): Promise<void> {
    if (this.baselines.has(relativePath)) return;
    await this.snapshot([relativePath]);
  }

  /** Return the unified diff of every snapshotted path against its
   *  current on-disk content. Empty string when nothing changed.
   *  Capped at MAX_DIFF_BYTES with a truncation marker. */
  async cumulativeDiff(): Promise<string> {
    const segments: string[] = [];
    for (const [rel, before] of this.baselines.entries()) {
      const abs = path.resolve(this.cwd, rel);
      let after: Baseline;
      try {
        after = await fs.readFile(abs, 'utf-8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') after = null;
        else throw e;
      }
      if (before === after) continue;
      const seg = formatUnifiedDiff(rel, before, after);
      if (seg) segments.push(seg);
    }
    return capWithMarker(segments.join('\n\n'));
  }

  /** Test hook: how many baselines have been captured. */
  size(): number {
    return this.baselines.size;
  }
}

function capWithMarker(s: string): string {
  if (s.length <= MAX_DIFF_BYTES) return s;
  const elided = s.length - MAX_DIFF_BYTES;
  return s.slice(0, MAX_DIFF_BYTES) + `\n\n[diff truncated at ${MAX_DIFF_BYTES} bytes — ${elided} more bytes elided]`;
}

/** Unified-diff for one file. */
function formatUnifiedDiff(relPath: string, before: Baseline, after: Baseline): string {
  if (before === after) return '';
  const beforeLines = before === null ? [] : splitKeepNewlines(before);
  const afterLines = after === null ? [] : splitKeepNewlines(after);

  const aLabel = before === null ? '/dev/null' : `a/${relPath}`;
  const bLabel = after === null ? '/dev/null' : `b/${relPath}`;

  const ops = lineDiff(beforeLines, afterLines);
  const hunks = collectHunks(ops, CONTEXT_LINES);
  if (hunks.length === 0) return '';

  const out: string[] = [];
  out.push(`--- ${aLabel}`);
  out.push(`+++ ${bLabel}`);
  for (const h of hunks) {
    out.push(`@@ -${h.beforeStart + 1},${h.beforeCount} +${h.afterStart + 1},${h.afterCount} @@`);
    for (const line of h.lines) out.push(line);
  }
  return out.join('\n');
}

function splitKeepNewlines(s: string): string[] {
  // Split into logical lines. Trailing newline is preserved on each
  // line except the last (which may or may not have one, like POSIX).
  if (s === '') return [];
  const out = s.split('\n');
  // If original ended with \n, the split produces a trailing '' which
  // represents "the final newline" — drop it (unified diff lines DON'T
  // include the trailing newline; it's implicit).
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

interface LineOp {
  kind: 'equal' | 'delete' | 'insert';
  text: string; // the line text (no leading +/-/' ')
}

/**
 * Line-level diff using a simple LCS (Hirschberg / dynamic-programming).
 * Returns ops in document order. For typical edits (a few lines changed
 * in a file of hundreds of lines) this is O(N×M) but with N×M small.
 * For huge files it's still bounded — the result is line-count
 * sensitive, not byte-count sensitive.
 */
function lineDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  // Build LCS length matrix.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack to produce ops.
  const ops: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'delete', text: a[i] });
      i++;
    } else {
      ops.push({ kind: 'insert', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'delete', text: a[i++] });
  while (j < m) ops.push({ kind: 'insert', text: b[j++] });
  return ops;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[]; // each line prefixed with ' '/'+'/'-'
}

/**
 * Group ops into unified-diff hunks with `context` lines of unchanged
 * surrounding code. Skip pure-equal stretches longer than 2×context.
 */
function collectHunks(ops: LineOp[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let beforeIdx = 0; // 0-based line index into the "before" file
  let afterIdx = 0;

  while (i < ops.length) {
    // Skip purely-equal runs up to first change.
    while (i < ops.length && ops[i].kind === 'equal') {
      // Tentatively advance — but if a change is within `context`
      // ahead, we'll back off to include it as preceding-context.
      let lookahead = i;
      while (lookahead < ops.length && lookahead < i + context && ops[lookahead].kind === 'equal') lookahead++;
      if (lookahead < ops.length && ops[lookahead].kind !== 'equal') break;
      beforeIdx++; afterIdx++; i++;
    }
    if (i >= ops.length) break;

    // Start a hunk. Include up to `context` preceding equal lines.
    const hunkLines: string[] = [];
    let preStart = Math.max(0, i - context);
    // Walk back to preStart, but only include 'equal' ops on the way.
    // Use bookkeeping: how many equal lines we step back.
    const preLines: string[] = [];
    let walkBack = i - 1;
    while (walkBack >= preStart && ops[walkBack].kind === 'equal' && preLines.length < context) {
      preLines.unshift(' ' + ops[walkBack].text);
      walkBack--;
    }
    const hunkBeforeStart = beforeIdx - preLines.length;
    const hunkAfterStart = afterIdx - preLines.length;
    hunkLines.push(...preLines);

    // Walk forward, collecting changes + interleaved equals (up to
    // 2×context equals before splitting into a new hunk).
    let beforeCount = preLines.length;
    let afterCount = preLines.length;
    let trailingEqualCount = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.kind === 'equal') {
        if (trailingEqualCount >= 2 * context) {
          // Decide whether to split: peek to see if more changes coming.
          let look = i;
          while (look < ops.length && ops[look].kind === 'equal') look++;
          if (look >= ops.length || look - i > context) {
            // No more changes within range — close the hunk with `context` trailing.
            break;
          }
        }
        hunkLines.push(' ' + op.text);
        beforeCount++; afterCount++;
        beforeIdx++; afterIdx++;
        trailingEqualCount++;
        i++;
      } else if (op.kind === 'delete') {
        hunkLines.push('-' + op.text);
        beforeCount++;
        beforeIdx++;
        trailingEqualCount = 0;
        i++;
      } else {
        // insert
        hunkLines.push('+' + op.text);
        afterCount++;
        afterIdx++;
        trailingEqualCount = 0;
        i++;
      }
    }

    // Trim trailing context to exactly `context` lines if we accumulated more.
    while (trailingEqualCount > context) {
      const last = hunkLines[hunkLines.length - 1];
      if (last.startsWith(' ')) {
        hunkLines.pop();
        beforeCount--; afterCount--; trailingEqualCount--;
        beforeIdx--; afterIdx--;
        i--;
      } else break;
    }

    hunks.push({
      beforeStart: hunkBeforeStart,
      beforeCount,
      afterStart: hunkAfterStart,
      afterCount,
      lines: hunkLines,
    });
  }
  return hunks;
}
