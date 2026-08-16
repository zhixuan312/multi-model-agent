// packages/core/src/events/stderr-log-subscriber.ts
//
// EnvelopeBus subscriber that streams every plain log entry to the daemon's
// stderr in `[mma] event=... ts=... key=val` snake_case format. Always-on
// for `mma serve` — there is no quiet mode and no `--verbose` flag.
// Replaces the 4.7.1 VerboseLogChannel after the 4.7.2 envelope-bus rewrite
// dropped it; `verbose` as a separate concept is gone (4.7.3+).
//
// Filters: emits PlainLogEntry (provider events + lifecycle one-offs).
// Envelope snapshots are intentionally NOT emitted — they're too noisy at
// stderr (one per 5s heartbeat + per mutation). LogWriter handles the file
// path for full envelope persistence.

import type { Subscriber, BusMessage } from './envelope-bus.js';
import type { PlainLogEntry } from './plain-log-entry.js';
import { redactSecrets } from '../identity/secret-redactor.js';

export class StderrLogSubscriber implements Subscriber {
  readonly name = 'stderr-log';

  constructor(private write: (line: string) => void = (line) => { process.stderr.write(line); }) {}

  receive(msg: BusMessage): void {
    if (msg.type !== 'plain') return;
    this.write(formatStderrLine(msg.entry) + '\n');
  }
}

/**
 * Format a PlainLogEntry as a single `[mma] event=... ts=... key=val` line.
 * Primitive values are emitted directly (snake-cased, quoted only when they
 * contain whitespace or quotes). One line per event — operators can grep this
 * stream the same way they'd grep the JSONL log.
 */
export function formatStderrLine(entry: PlainLogEntry): string {
  const fields = entry.fields ?? {};
  const eventName = typeof fields['event'] === 'string' ? fields['event'] : entry.kind;
  const parts: string[] = [`event=${eventName}`, `ts=${entry.ts}`];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'event') continue;
    if (v === undefined || v === null) continue;
    const snake = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (typeof v === 'string' && /[\s"\\]/.test(v)) {
      parts.push(`${snake}=${JSON.stringify(v)}`);
    } else {
      parts.push(`${snake}=${v}`);
    }
  }
  // Redacted, like the JSONL sink.
  //
  // `redactSecrets` was applied ONLY in `log-writer.ts` — the sink that is OFF by default. This
  // one is always on for `mma serve`, so the stream an operator actually sees, scrolls back
  // through, captures in CI, and pastes into a bug report was the UNREDACTED one, while the
  // opt-in file copy of the same event was clean. Provider events carry whole command lines
  // (`codex_command_started`), error messages, and serialized tool inputs, so a token in any of
  // them printed verbatim.
  //
  // Applied to the composed line rather than per field, matching what `LogWriter` does with the
  // whole record: a secret is a secret wherever in the line it lands.
  return redactSecrets(`[mma] ${parts.join(' ')}`) as string;
}
