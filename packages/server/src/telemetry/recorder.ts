import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './consent.js';
import { getOrCreateIdentity } from './identity.js';
import { deleteInstallId } from './install-id.js';
import { buildInstallMeta } from './install-meta.js';
import { Queue } from './queue.js';
import { readGeneration, bumpGeneration } from './generation.js';
import { SCHEMA_VERSION, TaskCompletedEventSchema, ValidatedTaskCompletedEventSchema } from '@zhixuan92/multi-model-agent-core/telemetry/types';
import type { TaskCompletedEventType } from '@zhixuan92/multi-model-agent-core/telemetry/types';
import {
  buildTaskCompletedEvent,
  type BuildContext,
} from '@zhixuan92/multi-model-agent-core/telemetry/event-builder';

export interface ValidationWarningsResult {
  warnings: Array<{ rule: string; path: string }>;
  baseIssues: Array<{ path: string; message: string }>;
  refinedIssues: Array<{ path: string; message: string }>;
}

/**
 * Run both base-schema and cross-field validation on a built event
 * without dropping it. Returns deduplicated warnings and separate
 * issue lists for logging. Deduplication key is `message::path` so
 * a base-schema issue that also surfaces in the superRefine'd parse
 * is stored once.
 */
export function collectValidationWarnings(
  event: TaskCompletedEventType,
): ValidationWarningsResult {
  const warningsMap = new Map<string, { rule: string; path: string }>();
  const baseIssues: Array<{ path: string; message: string }> = [];
  const refinedIssues: Array<{ path: string; message: string }> = [];

  const baseParsed = TaskCompletedEventSchema.safeParse(event);
  if (!baseParsed.success) {
    for (const i of baseParsed.error.issues) {
      const path = i.path.join('.');
      const key = `${i.message}::${path}`;
      warningsMap.set(key, { rule: i.message, path });
      baseIssues.push({ path, message: i.message });
    }
  }

  const refined = ValidatedTaskCompletedEventSchema.safeParse(event);
  if (!refined.success) {
    for (const i of refined.error.issues) {
      const path = i.path.join('.');
      const key = `${i.message}::${path}`;
      warningsMap.set(key, { rule: i.message, path });
      refinedIssues.push({ path, message: i.message });
    }
  }

  // R6b: soft warning when cached tokens grossly exceed input tokens per stage.
  // Non-nullability is enforced by the schema; treat null as 0 for this check.
  for (const r6b of checkR6b(event)) {
    const key = `${r6b.rule}::${r6b.path}`;
    if (!warningsMap.has(key)) {
      warningsMap.set(key, r6b);
    }
  }

  return { warnings: [...warningsMap.values()], baseIssues, refinedIssues };
}

function checkR6b(event: TaskCompletedEventType): Array<{ rule: string; path: string }> {
  const warnings: Array<{ rule: string; path: string }> = [];
  for (let i = 0; i < event.stages.length; i++) {
    const s = event.stages[i];
    if (s.inputTokens > 0) {
      const cachedSum = (s.cachedReadTokens ?? 0) + (s.cachedCreationTokens ?? 0);
      if (cachedSum > 100 * s.inputTokens) {
        warnings.push({ rule: 'R6b', path: `stages[${i}]` });
      }
    }
  }
  return warnings;
}

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

        const { warnings, baseIssues, refinedIssues } = collectValidationWarnings(event);

        if (baseIssues.length > 0) {
          console.warn('mma-telemetry: schema warning (event still emitted)', {
            eventId: event.eventId,
            issues: baseIssues,
          });
        }

        if (refinedIssues.length > 0) {
          const stageModelsByName = (event.stages ?? []).reduce(
            (acc: Record<string, string>, s: { name: string; model?: string }) => {
              if (s.name && s.model) acc[s.name] = s.model;
              return acc;
            },
            {},
          );
          console.warn('mma-telemetry: cross-field warning (event still emitted)', {
            eventId: event.eventId,
            implementerModel: event.implementerModel,
            stageModels: stageModelsByName,
            totalDurationMs: event.totalDurationMs,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            issues: refinedIssues.map((e) => ({
              rule: e.message,
              path: e.path,
            })),
          });
        }

        const enrichedEvent = warnings.length > 0
          ? { ...event, validation_warnings: warnings }
          : event;
        enqueue(enrichedEvent as unknown as Record<string, unknown>);
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
