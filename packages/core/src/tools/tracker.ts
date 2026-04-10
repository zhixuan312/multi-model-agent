/**
 * Tracks file accesses inside a sub-agent run so the runner can report what
 * the worker actually touched. Reads and writes are stored separately because
 * they answer different questions for the caller:
 *
 *   - filesRead    → "what did the worker look at?" (debugging, audit trail)
 *   - filesWritten → "what changed on disk?"        (review, rollback)
 *
 * Read-only tasks (audits, surveys, exploration) used to return an empty
 * `files` array because the original tracker only recorded writes. That made
 * it impossible to tell whether the worker had done substantial work or had
 * bailed out immediately.
 */
export class FileTracker {
  private reads = new Set<string>();
  private writes = new Set<string>();

  trackRead(filePath: string): void {
    this.reads.add(filePath);
  }

  trackWrite(filePath: string): void {
    this.writes.add(filePath);
  }

  getReads(): string[] {
    return [...this.reads].sort();
  }

  getWrites(): string[] {
    return [...this.writes].sort();
  }

  reset(): void {
    this.reads.clear();
    this.writes.clear();
  }
}
