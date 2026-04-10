/**
 * Tracks file accesses and tool invocations inside a sub-agent run so the
 * runner can report what the worker actually did. Reads, writes, and tool
 * calls are stored separately because they answer different questions for
 * the caller:
 *
 *   - filesRead    → "what did the worker look at?" (debugging, audit trail)
 *   - filesWritten → "what changed on disk?"        (review, rollback)
 *   - toolCalls    → "what did the worker actually do, in order?"
 *                                                   (debugging, post-mortem)
 *
 * Read-only tasks (audits, surveys, exploration) used to return an empty
 * `files` array because the original tracker only recorded writes. That made
 * it impossible to tell whether the worker had done substantial work or had
 * bailed out immediately.
 */
export class FileTracker {
  private reads = new Set<string>();
  private writes = new Set<string>();
  private toolCalls: string[] = [];

  trackRead(filePath: string): void {
    this.reads.add(filePath);
  }

  trackWrite(filePath: string): void {
    this.writes.add(filePath);
  }

  /**
   * Record a one-line summary of a tool invocation. Order is preserved so
   * the caller can reconstruct what the worker actually did.
   */
  trackToolCall(summary: string): void {
    this.toolCalls.push(summary);
  }

  getReads(): string[] {
    return [...this.reads].sort();
  }

  getWrites(): string[] {
    return [...this.writes].sort();
  }

  getToolCalls(): string[] {
    return [...this.toolCalls];
  }

  reset(): void {
    this.reads.clear();
    this.writes.clear();
    this.toolCalls = [];
  }
}
