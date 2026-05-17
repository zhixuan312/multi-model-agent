// packages/core/src/events/log-writer.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Subscriber, BusMessage } from './envelope-bus.js';
import { JsonlWriter } from './jsonl-writer.js';
import { redactSecrets } from '../identity/secret-redactor.js';

const INLINE_BODY_LIMIT_BYTES = 16_384;

export interface LogWriterOpts {
  diagnosticsLog: boolean;                      // if true → file; else → stderr
  logDir?: string;                              // defaults to ~/.multi-model/logs
}

export class LogWriter implements Subscriber {
  readonly name = 'log-writer';
  private writer: JsonlWriter | null = null;
  private requestSpillDir: string;

  constructor(private opts: LogWriterOpts) {
    const baseDir = opts.logDir ?? join(homedir(), '.multi-model', 'logs');
    if (opts.diagnosticsLog) this.writer = new JsonlWriter({ dir: baseDir });
    this.requestSpillDir = join(baseDir, 'requests');
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
      process.stderr.write(`[mmagent] log_writer_error: ${(err as Error).message}\n`);
    }
  }

  /** Spill an oversized request body to disk and return the path. */
  async spillRequestBody(input: { batchId: string; body: unknown }): Promise<{ path: string; bytes: number }> {
    await fsp.mkdir(this.requestSpillDir, { recursive: true, mode: 0o700 });
    const path = join(this.requestSpillDir, `${input.batchId}.json`);
    const buf = Buffer.from(JSON.stringify(input.body), 'utf8');
    await fsp.writeFile(path, buf, { mode: 0o600, flag: 'wx' }).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; });
    return { path, bytes: buf.byteLength };
  }

  inlineBodyLimit(): number { return INLINE_BODY_LIMIT_BYTES; }

  private serialize(msg: BusMessage): Record<string, unknown> {
    if (msg.type === 'envelope') return { ts: new Date().toISOString(), kind: 'envelope_snapshot', reason: msg.reason, envelope: msg.envelope };
    return { ts: msg.entry.ts, kind: msg.entry.kind, fields: msg.entry.fields };
  }
}
