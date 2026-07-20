// packages/core/src/events/log-writer.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Subscriber, BusMessage } from './envelope-bus.js';
import { JsonlWriter } from './jsonl-writer.js';
import { redactSecrets } from '../identity/secret-redactor.js';

export interface LogWriterOpts {
  diagnosticsLog: boolean;                      // if true → file; else → stderr
  logDir?: string;                              // defaults to ~/.mma/logs
}

export class LogWriter implements Subscriber {
  readonly name = 'log-writer';
  private writer: JsonlWriter | null = null;

  constructor(opts: LogWriterOpts) {
    const baseDir = opts.logDir ?? join(homedir(), '.mma', 'logs');
    if (opts.diagnosticsLog) this.writer = new JsonlWriter({ dir: baseDir });
  }

  receive(msg: BusMessage): void {
    // No-op when JSONL persistence is disabled — stderr observability is owned
    // by StderrLogSubscriber, wired in server.ts. Falling back to stderr here
    // would double-log every event.
    if (!this.writer) return;
    const record = this.serialize(msg);
    // redactSecrets is a recursive walker that returns the redacted value at the same shape.
    const redactedRecord = redactSecrets(record) as Record<string, unknown>;
    try { this.writer.writeLine(redactedRecord); } catch (err) {
      process.stderr.write(`[mma] log_writer_error: ${(err as Error).message}\n`);
    }
  }

  private serialize(msg: BusMessage): Record<string, unknown> {
    if (msg.type === 'envelope') return { ts: new Date().toISOString(), kind: 'envelope_snapshot', reason: msg.reason, envelope: msg.envelope };
    return { ts: msg.entry.ts, kind: msg.entry.kind, fields: msg.entry.fields };
  }
}
