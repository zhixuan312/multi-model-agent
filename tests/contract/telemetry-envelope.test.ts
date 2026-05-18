import { describe, it, expect } from 'vitest';
import { TelemetryUploader } from '../../packages/core/src/events/telemetry-uploader.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';

describe('telemetry envelope (v2)', () => {
  it('TelemetryUploader passes sealed envelopes to recorder.enqueue', () => {
    const enqueued: Record<string, unknown>[] = [];
    const stubRecorder = { enqueue: (e: Record<string, unknown>) => enqueued.push(e) };
    const uploader = new TelemetryUploader({
      recorder: stubRecorder,
      buildOpts: () => ({
        toolMode: 'full' as const,
        implementerModel: 'claude-sonnet-4-6',
        implementerTier: 'standard' as const,
        mainModelFamily: 'claude',
      }),
    });
    const bus = new EnvelopeBus();
    bus.subscribe(uploader);

    const store = TaskEnvelopeStore.create(
      {
        taskId: 'test-task-1',
        batchId: 'test-batch-1',
        taskIndex: 0,
        route: 'delegate',
        agentType: 'standard',
        client: 'test',
        mainModel: 'claude-sonnet-4-6',
        cwd: '/tmp/test',
        reviewPolicy: 'full' as const,
      },
      bus,
    );

    // Add a stage so toWireRecord validation passes
    store.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard', startedAt: new Date().toISOString() });
    store.completeStage('implementing', 1, {
      outcome: 'advance',
      costUSD: 0.01,
      durationMs: 100,
      turnsUsed: 1,
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      
      
      filesWrittenCount: 0,
    });

    store.seal({ status: 'done', terminalAt: new Date().toISOString(), stopReason: null, realFilesChanged: [] });
    expect(enqueued).toHaveLength(1);
    // Verify the record has been enqueued as a valid task completed event
    const record = enqueued[0] as Record<string, unknown>;
    expect(record.eventId).toBeDefined();
    expect(record.route).toBe('delegate');
    expect(record.terminalStatus).toBe('ok');
  });

  it('TelemetryUploader ignores plain log entries', () => {
    const enqueued: Record<string, unknown>[] = [];
    const stubRecorder = { enqueue: (e: Record<string, unknown>) => enqueued.push(e) };
    const uploader = new TelemetryUploader({
      recorder: stubRecorder,
      buildOpts: () => ({
        toolMode: 'full' as const,
        implementerModel: 'claude-sonnet-4-6',
        implementerTier: 'standard' as const,
        mainModelFamily: 'claude',
      }),
    });
    const bus = new EnvelopeBus();
    bus.subscribe(uploader);

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'batch_created',
      fields: { batch_id: 'test-batch-1' },
    });

    expect(enqueued).toHaveLength(0);
  });
});
