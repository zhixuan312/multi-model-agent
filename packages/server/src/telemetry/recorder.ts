import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './consent.js';
import { getOrCreateIdentity } from './identity.js';
import { deleteInstallId } from './install-id.js';
import { buildInstallMeta } from './install-meta.js';
import { Queue } from './queue.js';
import { readGeneration, bumpGeneration } from './generation.js';
import { SCHEMA_VERSION } from '@zhixuan92/multi-model-agent-core/telemetry/types';
import {
  buildTaskCompletedEvent,
  buildSessionStartedEvent,
  buildInstallChangedEvent,
  buildSkillInstalledEvent,
  type BuildContext,
  type SessionSnapshot,
} from '@zhixuan92/multi-model-agent-core/telemetry/event-builder';

export interface Recorder {
  readonly signal: AbortSignal;
  recordTaskCompleted(ctx: BuildContext): void;
  recordSessionStarted(snap: SessionSnapshot): void;
  recordInstallChanged(from: string | null, to: string, trigger: string): void;
  recordSkillInstalled(skillId: string, client: string): void;
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
        install: {
          installId: meta.installId,
          mmagentVersion: meta.mmagentVersion,
          os: meta.os,
          nodeMajor: meta.nodeMajor,
          language: meta.language,
          tzOffsetBucket: meta.tzOffsetBucket,
        },
        generation: gen,
        event,
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
        enqueue(buildTaskCompletedEvent(ctx));
      } catch {
        dropped++;
      }
    },

    recordSessionStarted(snap) {
      try {
        const d = decide(homeDir);
        if (!d.enabled) return;
        enqueue(buildSessionStartedEvent(snap));
      } catch {
        dropped++;
      }
    },

    recordInstallChanged(from, to, trigger) {
      try {
        const d = decide(homeDir);
        if (!d.enabled) return;
        enqueue(buildInstallChangedEvent(from, to, trigger as 'fresh_install' | 'upgrade' | 'downgrade'));
      } catch {
        dropped++;
      }
    },

    recordSkillInstalled(skillId, client) {
      try {
        const d = decide(homeDir);
        if (!d.enabled) return;
        enqueue(buildSkillInstalledEvent(skillId, client));
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
