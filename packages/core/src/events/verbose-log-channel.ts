/**
 * VerboseLogChannel — bus sink that streams every event to the daemon's
 * stderr in the `[mmagent verbose] event=...` snake_case format.
 *
 * Always registered (4.6.0+): verbose streaming is compulsory. The only
 * remaining diagnostics toggle is `diagnostics.log`, which controls
 * file persistence via `LocalLogSink`. File = `log`; verbose = always on,
 * stderr.
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
    private readonly stream: { write: (s: string) => boolean } = process.stderr,
  ) {}

  emit(event: Record<string, unknown>): void {
    let line: string;
    try {
      line = formatVerboseLine(event);
    } catch {
      line = `[mmagent verbose] _serializeError`;
    }
    try {
      this.stream.write(line + '\n');
    } catch {
      // stream write failed — drop the line; this is best-effort observability.
    }
  }
}
