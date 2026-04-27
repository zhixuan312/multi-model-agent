import { describe, it, expect } from 'vitest';
import { TelemetrySink } from '../../packages/core/src/observability/telemetry-sink.js';
import { CLOUD_EVENT_NAMES, type EventType } from '../../packages/core/src/observability/events.js';

describe('telemetry envelope (v2)', () => {
  it('TelemetrySink passes cloud events to recorder.enqueue', () => {
    const enqueued: Record<string, unknown>[] = [];
    const stubRecorder = { enqueue: (e: Record<string, unknown>) => enqueued.push(e) };
    const sink = new TelemetrySink(stubRecorder);

    const ev = {
      event: 'task.completed',
      ts: new Date().toISOString(),
      route: 'delegate',
      agentType: 'standard',
      capabilities: [],
      toolMode: 'full',
      triggeredFromSkill: 'mma-delegate',
      client: 'test',
      fileCountBucket: '1-5',
      durationBucket: '<10s',
      costBucket: '$0',
      savedCostBucket: '$0',
      implementerModelFamily: 'claude',
      implementerModel: 'claude-sonnet-4-6',
      terminalStatus: 'ok',
      workerStatus: 'done',
      errorCode: null,
      escalated: false,
      fallbackTriggered: false,
      topToolNames: [],
      stages: {},
    } as unknown as EventType;

    sink.emit(ev);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toHaveProperty('event', 'task.completed');
  });

  it('TelemetrySink ignores non-cloud events', () => {
    const enqueued: Record<string, unknown>[] = [];
    const stubRecorder = { enqueue: (e: Record<string, unknown>) => enqueued.push(e) };
    const sink = new TelemetrySink(stubRecorder);

    const ev = {
      event: 'heartbeat',
      ts: new Date().toISOString(),
      batchId: '00000000-0000-0000-0000-000000000001',
      taskIndex: 0,
      elapsed: '10s',
      stage: 'implementing',
      tools: 0,
      read: 0,
      wrote: 0,
      text: 0,
      cost: null,
      idleMs: 0,
    } as unknown as EventType;

    sink.emit(ev);
    expect(enqueued).toHaveLength(0);
  });

  it('CLOUD_EVENT_NAMES includes all four cloud event discriminators', () => {
    expect(CLOUD_EVENT_NAMES.has('task.completed')).toBe(true);
    expect(CLOUD_EVENT_NAMES.has('session.started')).toBe(true);
    expect(CLOUD_EVENT_NAMES.has('install.changed')).toBe(true);
    expect(CLOUD_EVENT_NAMES.has('skill.installed')).toBe(true);
    expect(CLOUD_EVENT_NAMES.size).toBe(4);
  });
});
