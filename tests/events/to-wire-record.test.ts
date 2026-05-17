import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

const seed = {
  taskId: 't',
  batchId: 'b',
  taskIndex: 0,
  route: 'delegate' as const,
  agentType: 'standard' as const,
  client: 'claude-code',
  mainModel: 'claude-opus-4-7',
  cwd: '/tmp',
};

describe('toWireRecord', () => {
  it('produces an envelope that passes ValidatedTaskCompletedEventSchema', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      costUSD: 0.05,
      turnsUsed: 3,
      inputTokens: 100,
      outputTokens: 50,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: ['/a', '/b'] });
    const wire = toWireRecord(s.snapshot(), {
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });
    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();
    expect(wire.filesWrittenCount).toBe(2);
    expect(wire.totalCostUSD).toBe(0.05);
  });

  it('drops PII fields: no file paths, no toolCalls, no findings text', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.recordToolCall({ stage: 'implementing', tool: 'Read', filesRead: ['/secret/path'] });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    s.seal({ status: 'done', stopReason: 'ok', realFilesChanged: ['/secret/path'] });
    const wire = toWireRecord(s.snapshot(), {
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'm',
      implementerTier: 'standard',
      mainModelFamily: 'other',
    });
    const json = JSON.stringify(wire);
    expect(json).not.toContain('/secret/path');
    expect(json).not.toContain('toolCalls');
    expect(json).not.toContain('findings');
  });
});
