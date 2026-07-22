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
  /** Max taskIds retained for once-per-task dedup. Bounds the set on a
   *  long-running server — the window only needs to cover near-simultaneous
   *  re-emits of the same sealed envelope. Default 10_000. */
  dedupCap?: number;
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
  private readonly dedupCap: number;
  constructor(private opts: TelemetryUploaderOpts) {
    this.dedupCap = opts.dedupCap ?? 10_000;
  }

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
      // Bound the dedup set — evict the oldest taskId (Set preserves insertion
      // order) once past the cap, so it can't grow without limit on a long run.
      if (this.uploaded.size > this.dedupCap) {
        const oldest = this.uploaded.values().next().value;
        if (oldest !== undefined) this.uploaded.delete(oldest);
      }
    } catch (err) {
      process.stderr.write(`[mma] telemetry_upload_error task=${env.taskId} err=${(err as Error).message}\n`);
    }
  }
}
