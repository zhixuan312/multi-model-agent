import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

// 4.7.4+ standardization: findingsOutcome / findingsOutcomeReason /
// outcomeInferred / outcomeMalformed live ONLY at the top level of the wire
// event. Per-stage rows do not carry these fields. The top-level value is
// rolled up across stages with priority: review > annotating > implementing.

const seed = {
  taskId: 't',
  batchId: 'b',
  taskIndex: 0,
  route: 'audit' as const,
  agentType: 'standard' as const,
  client: 'claude-code',
  mainModel: 'claude-opus-4-7',
  cwd: '/tmp',
  reviewPolicy: 'reviewed' as const,
};

describe('toWireRecord — top-level findings-outcome rollup', () => {
  it('lifts implementing-stage outcome to top-level when no review stage ran', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      costUSD: 0.05,
      turnsUsed: 3,
      inputTokens: 100,
      outputTokens: 50,
      findingsOutcome: 'found',
      findingsOutcomeReason: '1 high-severity finding',
      outcomeInferred: false,
      outcomeMalformed: false,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();
    // Top-level carries the outcome rollup
    expect(wire.findingsOutcome).toBe('found');
    expect(wire.findingsOutcomeReason).toBe('1 high-severity finding');
    expect(wire.outcomeInferred).toBe(false);
    expect(wire.outcomeMalformed).toBe(false);
    // Per-stage rows do NOT carry outcome fields anymore
    const implStage = wire.stages.find((st: any) => st.name === 'implementing') as any;
    expect(implStage.findingsOutcome).toBeUndefined();
    expect(implStage.findingsOutcomeReason).toBeUndefined();
    expect(implStage.outcomeInferred).toBeUndefined();
    expect(implStage.outcomeMalformed).toBeUndefined();
  });

  it('prefers review-stage outcome over implementing when both are present', () => {
    const s = TaskEnvelopeStore.create({ ...seed, route: 'delegate' });
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 10,
    });
    s.startStage('reviewing', { model: 'claude-opus-4-7', tier: 'complex' });
    s.completeStage('reviewing', 1, {
      outcome: 'advance',
      durationMs: 200,
      inputTokens: 50,
      outputTokens: 30,
      verdict: 'approved',
      findingsOutcome: 'clean',
      findingsOutcomeReason: null,
      outcomeInferred: false,
      outcomeMalformed: false,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    expect(wire.findingsOutcome).toBe('clean');
    expect(wire.findingsOutcomeReason).toBeNull();
    expect(wire.outcomeInferred).toBe(false);
    // Review-stage row carries verdict but NOT outcome fields
    const reviewStage = wire.stages.find((st: any) => st.name === 'review') as any;
    expect(reviewStage.verdict).toBe('approved');
    expect(reviewStage.findingsOutcome).toBeUndefined();
    expect(reviewStage.findingsBySeverity).toBeUndefined();
  });

  it('falls back to annotating when implementing has no outcome and no review ran', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
    });
    s.startStage('annotating', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('annotating', 1, {
      outcome: 'advance',
      durationMs: 100,
      inputTokens: 20,
      outputTokens: 10,
      findingsOutcome: 'not_applicable',
      findingsOutcomeReason: 'project-level question',
      outcomeInferred: true,
      outcomeMalformed: false,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    expect(wire.findingsOutcome).toBe('not_applicable');
    expect(wire.findingsOutcomeReason).toBe('project-level question');
    expect(wire.outcomeInferred).toBe(true);
    const annStage = wire.stages.find((st: any) => st.name === 'annotating') as any;
    expect(annStage.findingsOutcome).toBeUndefined();
  });

  it('omits top-level outcome fields when no stage emitted one', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      toolMode: 'full',
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();
    expect(wire.findingsOutcome).toBeUndefined();
    expect(wire.findingsOutcomeReason).toBeUndefined();
    expect(wire.outcomeInferred).toBeUndefined();
    expect(wire.outcomeMalformed).toBeUndefined();
  });
});
