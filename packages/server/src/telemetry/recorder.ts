import { decide } from './consent.js';
import { getOrCreateIdentity } from './identity.js';
import { buildInstallMeta } from './install-meta.js';
import { Queue } from './queue.js';
import { readGeneration } from './generation.js';
import { SCHEMA_VERSION } from '@zhixuan92/multi-model-agent-core/events/wire-schema';

export interface Recorder {
  enqueue(event: Record<string, unknown>): void;
}

let _recorder: Recorder | null = null;

export function getRecorder(): Recorder {
  if (!_recorder) {
    throw new Error('Recorder not initialized — call createRecorder first');
  }
  return _recorder;
}

export function createRecorder(opts: { homeDir: string; mmaVersion: string }): Recorder {
  const recorder = _buildRecorder(opts);
  _recorder = recorder;
  return recorder;
}

function _buildRecorder(opts: { homeDir: string; mmaVersion: string }): Recorder {
  const { homeDir, mmaVersion } = opts;
  const queue = new Queue(homeDir);
  let _installId: string | null = null;

  const resolveInstallId = (): string => {
    if (!_installId) {
      _installId = getOrCreateIdentity(homeDir).installId;
    }
    return _installId;
  };

  const enqueue = (event: Record<string, unknown>): void => {
    try {
      const d = decide(homeDir);
      if (!d.enabled) return;
      const id = resolveInstallId();
      const meta = buildInstallMeta({ installId: id, mmaVersion });
      const gen = readGeneration(homeDir);

      queue.append({
        schemaVersion: SCHEMA_VERSION,
        installId: meta.installId,
        mmaVersion: meta.mmaVersion,
        os: meta.os,
        nodeMajor: meta.nodeMajor,
        generation: gen,
        events: [event],
      }).catch(() => {
        // best-effort: telemetry enqueue is fire-and-forget
      });
    } catch {
      // swallow — telemetry must never break the request path
    }
  };

  return { enqueue };
}
