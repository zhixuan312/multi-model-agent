// packages/core/src/events/telemetry-uploader.ts
import type { Subscriber, BusMessage } from './envelope-bus.js';
import type { TaskEnvelope } from './task-envelope.js';
import { toWireRecord } from './to-wire-record.js';

export interface RecorderLike {
  enqueue(event: unknown): void;
}

export interface ConsentLike {
  decide(): { enabled: boolean };
}

export interface TelemetryUploaderOpts {
  recorder: RecorderLike | null;
  consent?: ConsentLike;
  buildOpts: (env: TaskEnvelope) => {
    toolMode: 'none' | 'readonly' | 'no-shell' | 'full';
    implementerModel: string;
    implementerTier: 'standard' | 'complex' | 'main';
    mainModelFamily: string;
  };
}

export class TelemetryUploader implements Subscriber {
  readonly name = 'telemetry-uploader';
  private uploaded = new Set<string>();
  constructor(private opts: TelemetryUploaderOpts) {}

  receive(msg: BusMessage): void {
    if (msg.type === 'plain') return;
    const env = msg.envelope;
    if (env.status === 'running') return;
    if (this.uploaded.has(env.taskId)) return;
    if (!this.opts.recorder) return;
    if (this.opts.consent && !this.opts.consent.decide().enabled) return;
    try {
      const record = toWireRecord(env, this.opts.buildOpts(env));
      this.opts.recorder.enqueue(record);
      this.uploaded.add(env.taskId);
    } catch (err) {
      process.stderr.write(`[mmagent] telemetry_upload_error task=${env.taskId} err=${(err as Error).message}\n`);
    }
  }
}
