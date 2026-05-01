import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './consent.js';
import { getOrCreateIdentity } from './identity.js';
import { deleteInstallId } from './install-id.js';
import { buildInstallMeta } from './install-meta.js';
import { Queue } from './queue.js';
import { readGeneration, bumpGeneration } from './generation.js';
import { SCHEMA_VERSION, TaskCompletedEventSchema, ValidatedTaskCompletedEventSchema } from '@zhixuan92/multi-model-agent-core/telemetry/types';
import {
  buildTaskCompletedEvent,
  type BuildContext,
} from '@zhixuan92/multi-model-agent-core/telemetry/event-builder';

export interface Recorder {
  readonly signal: AbortSignal;
  recordTaskCompleted(ctx: BuildContext): void;
  enqueue(event: Record<string, unknown>): void;
  revokeIdentity(options?: { deleteInstallId?: boolean }): Promise<void>;
}

let _recorder: Recorder | null = null;

export function getRecorder(): Recorder {
  if (!_recorder) {
    throw new Error('Recorder not initialized — call createRecorder first');
  }
  return _recorder;
}

export function setRecorderForTest(r: Recorder): void {
  _recorder = r;
}

export function createRecorder(opts: { homeDir: string; mmagentVersion: string }): Recorder {
  const recorder = _buildRecorder(opts);
  _recorder = recorder;
  return recorder;
}

function _buildRecorder(opts: { homeDir: string; mmagentVersion: string }): Recorder {
  const { homeDir, mmagentVersion } = opts;
  const queue = new Queue(homeDir);
  const controller = new AbortController();
  let _installId: string | null = null;
  let dropped = 0;

  const resolveInstallId = (): string => {
    if (!_installId) {
      _installId = getOrCreateIdentity(homeDir).installId;
    }
    return _installId;
  };

  const enqueue = (event: Record<string, unknown>): void => {
    try {
      const id = resolveInstallId();
      const meta = buildInstallMeta({ installId: id, mmagentVersion });
      const gen = readGeneration(homeDir);

      queue.append({
        schemaVersion: SCHEMA_VERSION,
        installId: meta.installId,
        mmagentVersion: meta.mmagentVersion,
        os: meta.os,
        nodeMajor: meta.nodeMajor,
        generation: gen,
        events: [event],
      }).catch(() => {
        dropped++;
      });
    } catch {
      dropped++;
    }
  };

  return {
    get signal() {
      return controller.signal;
    },

    enqueue,

    recordTaskCompleted(ctx) {
      try {
        const d = decide(homeDir);
        if (!d.enabled) return;
        const event = buildTaskCompletedEvent(ctx);
        // Validate against the BASE schema (caps, types, enums) — these are
        // non-negotiable wire-format constraints. Drop only on those failures.
        // SuperRefine cross-field rules (R1–R11) are checked separately and
        // logged as warnings, but do NOT drop the event: backend uses
        // passthrough so degenerate rows can be filtered at query time, and
        // 3.10.2's drop-on-superRefine behaviour silently lost real telemetry
        // on 1ms clock-skew (R4) and other measurement-precision edge cases.
        const baseParsed = TaskCompletedEventSchema.safeParse(event);
        if (!baseParsed.success) {
          console.warn('mma-telemetry: dropping schema-invalid event', {
            eventId: event.eventId,
            issues: baseParsed.error.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
          });
          return;
        }
        const refined = ValidatedTaskCompletedEventSchema.safeParse(baseParsed.data);
        if (!refined.success) {
          console.warn('mma-telemetry: cross-field validation warning (event still emitted)', {
            eventId: event.eventId,
            issues: refined.error.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
          });
        }
        enqueue(baseParsed.data as Record<string, unknown>);
      } catch {
        dropped++;
      }
    },

    async revokeIdentity(options) {
      await bumpGeneration(homeDir);
      controller.abort();
      const queuePath = join(homeDir, 'telemetry-queue.ndjson');
      if (existsSync(queuePath)) unlinkSync(queuePath);
      _installId = null;
      if (options?.deleteInstallId) {
        deleteInstallId(homeDir);
      }
    },
  };
}
