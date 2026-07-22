// tests/events/telemetry-uploader.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TelemetryUploader } from '../../packages/core/src/events/telemetry-uploader.js';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

const seed = { taskId: 't1', batchId: 'b', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'reviewed' as const };
const buildOpts = () => ({ toolMode: 'full' as const, implementerModel: 'claude-sonnet-4-6', implementerTier: 'standard' as const, mainModelFamily: 'claude' });

describe('TelemetryUploader', () => {
  it('ignores plain entries', () => {
    const enqueue = vi.fn();
    const u = new TelemetryUploader({ recorder: { enqueue }, buildOpts });
    u.receive({ type: 'plain', entry: { ts: 't', kind: 'batch_created', fields: {} } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores running snapshots', () => {
    const enqueue = vi.fn();
    const u = new TelemetryUploader({ recorder: { enqueue }, buildOpts });
    const s = TaskEnvelopeStore.create(seed);
    u.receive({ type: 'envelope', envelope: s.snapshot(), reason: 'startStage' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('uploads exactly once on first sealed snapshot per taskId', () => {
    const enqueue = vi.fn();
    const u = new TelemetryUploader({ recorder: { enqueue }, buildOpts });
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.completeStage('implementing', 1, { outcome: 'advance', durationMs: 1, inputTokens: 1, outputTokens: 1 });
    s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: [] });
    const snap = s.snapshot();
    u.receive({ type: 'envelope', envelope: snap, reason: 'seal' });
    u.receive({ type: 'envelope', envelope: snap, reason: 'seal' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('bounds the dedup set (evicts oldest) so it cannot grow unbounded', () => {
    const enqueue = vi.fn();
    const u = new TelemetryUploader({ recorder: { enqueue }, buildOpts, dedupCap: 2 });
    const sealed = (taskId: string) => {
      const s = TaskEnvelopeStore.create({ ...seed, taskId });
      s.startStage('implementing', { model: 'm', tier: 'standard' });
      s.completeStage('implementing', 1, { outcome: 'advance', durationMs: 1, inputTokens: 1, outputTokens: 1 });
      s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: [] });
      return s.snapshot();
    };
    const a = sealed('A'), b = sealed('B'), c = sealed('C');
    u.receive({ type: 'envelope', envelope: a, reason: 'seal' }); // dedup {A}
    u.receive({ type: 'envelope', envelope: b, reason: 'seal' }); // {A,B}
    u.receive({ type: 'envelope', envelope: c, reason: 'seal' }); // size>2 → evict A → {B,C}
    expect(enqueue).toHaveBeenCalledTimes(3);
    // C is still within the dedup window → re-send is deduped (not re-uploaded).
    u.receive({ type: 'envelope', envelope: c, reason: 'seal' });
    expect(enqueue).toHaveBeenCalledTimes(3);
    // A was evicted (bounded set) → re-send uploads again, proving the set is capped.
    u.receive({ type: 'envelope', envelope: a, reason: 'seal' });
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it('respects consent', () => {
    const enqueue = vi.fn();
    const u = new TelemetryUploader({ recorder: { enqueue }, consent: { decide: () => ({ enabled: false }) }, buildOpts });
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.completeStage('implementing', 1, { outcome: 'advance', durationMs: 1, inputTokens: 1, outputTokens: 1 });
    s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: [] });
    u.receive({ type: 'envelope', envelope: s.snapshot(), reason: 'seal' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
