/**
 * Tracks file accesses and tool invocations inside a sub-agent run so the
 * runner can report what the worker actually did. Reads, writes, and tool
 * calls are stored separately because they answer different questions for
 * the caller:
 *
 *   - filesRead    → "what did the worker look at?" (debugging, audit trail)
 *   - directoriesListed → "which directories were enumerated?" (exploration)
 *   - filesWritten → "what changed on disk?"        (review, rollback)
 *   - toolCalls    → "what did the worker actually do, in order?"
 *                                                   (debugging, post-mortem)
 *
 * Read-only tasks (audits, surveys, exploration) used to return an empty
 * `files` array because the original tracker only recorded writes. That made
 * it impossible to tell whether the worker had done substantial work or had
 * bailed out immediately.
 */

/**
 * A4b §2a path-validity filter (4.2.2+).
 *
 * Returns true iff `entry` is a real, sandbox-safe relative filesystem
 * path that the platform can verify via `stat(taskSpec.cwd, entry)`.
 * Returns false for anything that looks like a shell-channel artifact,
 * shell injection, or sandbox-escape attempt.
 *
 * The five rules (in order — first match wins):
 *  1. Reject the literal `shell:` prefix (used by Gap-11 shell-detection
 *     to attribute heuristic shell writes; A4b stops conflating those
 *     with real paths).
 *  2. Reject entries with shell control characters: < > | & ; ` $ ( )
 *  3. Reject entries that don't match ^[A-Za-z0-9_.][^\s'"]*$
 *     (must start with alphanumeric/underscore/dot; no whitespace/quotes).
 *  4. Reject entries longer than 4096 chars (PATH_MAX guard).
 *  5. Reject absolute paths. `path.join(cwd, '/etc/passwd')` returns
 *     `/etc/passwd` (path.join ignores cwd when arg2 is absolute) — silent
 *     sandbox escape.
 */
export function filterValidWritePath(entry: string): boolean {
  if (typeof entry !== 'string' || entry.length === 0) return false;
  if (entry.length > 4096) return false;
  if (entry.startsWith('shell:')) return false;
  // Shell control chars: <, >, |, &, ;, backtick (`), $, (, )
  if (/[<>|&;`$()]/.test(entry)) return false;
  // Path shape: alphanumeric/_/. start, no whitespace, no quotes
  if (!/^[A-Za-z0-9_.][^\s'"]*$/.test(entry)) return false;
  // Sandbox-escape guard
  if (entry.startsWith('/')) return false;
  return true;
}

export class FileTracker {
  private reads = new Set<string>();
  private dirs: string[] = [];
  private writes = new Set<string>();
  private toolCalls: string[] = [];
  private readonly onToolCall?: (summary: string) => void;

  /**
   * @param onToolCall Optional callback invoked synchronously after every
   *   `trackToolCall(...)`. Used by runners (Task 9+) to stream tool
   *   invocations out as `InternalRunnerEvent`s in real time. The callback must
   *   not throw; the runner wraps it in `safeSink` before passing it in.
   */
  constructor(onToolCall?: (summary: string) => void) {
    this.onToolCall = onToolCall;
  }

  trackRead(filePath: string): void {
    this.reads.add(filePath);
  }

  trackDirectoryList(dirPath: string): void {
    this.dirs.push(dirPath);
  }

  trackWrite(filePath: string): void {
    this.writes.add(filePath);
  }

  /**
   * Record a one-line summary of a tool invocation. Order is preserved so
   * the caller can reconstruct what the worker actually did. If an
   * `onToolCall` callback was supplied at construction, it is fired
   * synchronously after the summary is recorded.
   */
  trackToolCall(summary: string): void {
    this.toolCalls.push(summary);
    this.onToolCall?.(summary);
  }

  getReads(): string[] {
    return [...this.reads].sort();
  }

  getDirectoriesListed(): string[] {
    return [...this.dirs];
  }

  getWrites(): string[] {
    return [...this.writes].sort();
  }

  getToolCalls(): string[] {
    return [...this.toolCalls];
  }

  reset(): void {
    this.reads.clear();
    this.dirs = [];
    this.writes.clear();
    this.toolCalls = [];
  }
}
