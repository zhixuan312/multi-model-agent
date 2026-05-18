import { describe, it, expect } from 'vitest';
import { PlainLogEntrySchema, PlainLogKindEnum } from '../../packages/core/src/events/plain-log-entry.js';
import type { TaskEnvelope } from '../../packages/core/src/events/task-envelope.js';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import type { Subscriber, BusMessage } from '../../packages/core/src/events/envelope-bus.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

describe('observability contract — envelope + plain entries', () => {
  it('every envelope snapshot conforms to TaskEnvelope shape', async () => {
    const captured: BusMessage[] = [];
    const testSink: Subscriber = {
      name: 'test-capture',
      receive: (msg) => captured.push(msg),
    };
    const bus = new EnvelopeBus();
    bus.subscribe(testSink);

    const store = TaskEnvelopeStore.create(
      {
        taskId: 'test-task-envelope-1',
        batchId: 'test-batch-envelope-1',
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

    store.recordToolCall({ stage: 'implementing', tool: 'bash', filesWritten: [] });
    store.seal({ status: 'done', terminalAt: new Date().toISOString(), stopReason: null, realFilesChanged: [] });

    const envelopeSnapshots = captured.filter((m) => m.type === 'envelope');
    expect(envelopeSnapshots.length).toBeGreaterThan(0);

    for (const msg of envelopeSnapshots) {
      if (msg.type !== 'envelope') continue;
      const env = msg.envelope;
      // Verify essential fields exist and have correct types
      expect(typeof env.taskId).toBe('string');
      expect(typeof env.batchId).toBe('string');
      expect(typeof env.taskIndex).toBe('number');
      expect(['delegate', 'audit', 'review', 'debug', 'investigate', 'execute-plan', 'retry', 'research']).toContain(env.route);
      expect(['standard', 'complex']).toContain(env.agentType);
      expect(typeof env.client).toBe('string');
      expect(typeof env.mainModel).toBe('string');
      expect(typeof env.cwd).toBe('string');
      expect(typeof env.startedAt).toBe('string');
      expect(['running', 'done', 'done_with_concerns', 'failed']).toContain(env.status);
      expect(Array.isArray(env.stages)).toBe(true);
      expect(Array.isArray(env.toolCalls)).toBe(true);
      expect(Array.isArray(env.filesWritten)).toBe(true);
      expect(Array.isArray(env.realFilesChanged)).toBe(true);
      expect(typeof env.totalCostUSD).toBe('number');
      expect(typeof env.totalInputTokens).toBe('number');
      expect(typeof env.totalOutputTokens).toBe('number');
      expect(typeof env.totalDurationMs).toBe('number');
      expect(typeof env.headline).toBe('object');
    }
  });

  it('every plain log entry conforms to PlainLogEntrySchema', async () => {
    const captured: BusMessage[] = [];
    const testSink: Subscriber = {
      name: 'test-capture',
      receive: (msg) => captured.push(msg),
    };
    const bus = new EnvelopeBus();
    bus.subscribe(testSink);

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'batch_created',
      fields: { batch_id: 'test-batch-1' },
    });

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'provider_event',
      fields: { provider: 'codex', event: 'codex_turn_completed', task_id: 'test-task-1' },
    });

    const plainEntries = captured.filter((m) => m.type === 'plain').map((m) => (m.type === 'plain' ? m.entry : null));
    expect(plainEntries.length).toBeGreaterThan(0);

    for (const entry of plainEntries) {
      if (!entry) continue;
      const result = PlainLogEntrySchema.safeParse(entry);
      expect(result.success, `entry failed validation: ${result.error?.message}`).toBe(true);
    }
  });

  it('every plain entry kind is in PlainLogKindEnum', async () => {
    const validKinds = PlainLogKindEnum.options;
    const captured: BusMessage[] = [];
    const testSink: Subscriber = {
      name: 'test-capture',
      receive: (msg) => captured.push(msg),
    };
    const bus = new EnvelopeBus();
    bus.subscribe(testSink);

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'batch_created',
      fields: { batch_id: 'test-batch-1' },
    });

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'request_received',
      fields: { batch_id: 'test-batch-1', route: 'delegate', body_bytes: 1024 },
    });

    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'stall_watchdog_armed',
      fields: { task_id: 'test-task-1', idle_threshold_ms: 30000 },
    });

    const plainEntries = captured.filter((m) => m.type === 'plain').map((m) => (m.type === 'plain' ? m.entry : null));
    expect(plainEntries.length).toBeGreaterThan(0);

    for (const entry of plainEntries) {
      if (!entry) continue;
      expect(validKinds).toContain(entry.kind);
    }
  });
});
