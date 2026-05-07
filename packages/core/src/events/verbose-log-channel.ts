/**
 * VerboseLogChannel — bus sink that streams every event to the daemon's
 * stdout in the `[mmagent verbose] event=...` snake_case format consistent
 * with the existing HTTP-handler breadcrumbs.
 *
 * Wired only when `diagnostics.verbose=true`. Independent of LocalLogSink,
 * which writes the JSONL file when `diagnostics.log=true`. The two flags
 * are deliberately orthogonal: file = `log`, console = `verbose`.
 *
 * Per v4 spec (horizontal_design.md:332): "writes every event verbatim
 * (no filter, no transform, no privacy filter — local audience, full
 * detail OK)".
 */

/**
 * Format a bus event as a single `[mmagent verbose] event=... ts=... key=val`
 * line. Primitive values are emitted directly (snake-cased, quoted only when
 * they contain whitespace or quotes); nested objects are JSON-encoded inline
 * so the line stays grep-able while preserving full structural detail.
 */
export function formatVerboseLine(event: Record<string, unknown>): string {
  const { event: eventName, ts, ...rest } = event;
  const eventStr = typeof eventName === 'string' ? eventName : 'unknown';
  const tsStr = typeof ts === 'string' ? ts : new Date().toISOString();

  const parts: string[] = [`event=${eventStr}`, `ts=${tsStr}`];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue;
    const snake = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (typeof v === 'object') {
      parts.push(`${snake}=${JSON.stringify(v)}`);
    } else if (typeof v === 'string' && /[\s"\\]/.test(v)) {
      parts.push(`${snake}=${JSON.stringify(v)}`);
    } else {
      parts.push(`${snake}=${v}`);
    }
  }
  return `[mmagent verbose] ${parts.join(' ')}`;
}

export class VerboseLogChannel {
  readonly name = 'verbose-log';
  constructor(
    private readonly stdout: { write: (s: string) => boolean } = process.stdout,
  ) {}

  emit(event: Record<string, unknown>): void {
    let line: string;
    try {
      line = formatVerboseLine(event);
    } catch {
      line = `[mmagent verbose] _serializeError`;
    }
    try {
      this.stdout.write(line + '\n');
    } catch {
      // stdout write failed — drop the line; this is best-effort observability.
    }
  }
}
