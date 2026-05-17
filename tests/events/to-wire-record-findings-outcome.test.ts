import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/wire-schema.js';

const seed = {
  taskId: 't',
  batchId: 'b',
  taskIndex: 0,
  route: 'audit' as const,
  agentType: 'standard' as const,
  client: 'claude-code',
  mainModel: 'claude-opus-4-7',
  cwd: '/tmp',
};

describe('toWireRecord — findings outcome projection', () => {
  it('projects findingsOutcome quartet from implementing stage to wire row', () => {
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
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    // Wire record should pass validation
    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();

    // Check the implementing stage has the four fields
    const implStage = wire.stages.find((s: any) => s.name === 'implementing');
    expect(implStage).toBeDefined();
    expect(implStage.findingsOutcome).toBe('found');
    expect(implStage.findingsOutcomeReason).toBe('1 high-severity finding');
    expect(implStage.outcomeInferred).toBe(false);
    expect(implStage.outcomeMalformed).toBe(false);
  });

  it('projects outcome fields from review stage to wire row', () => {
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
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    // Check the review stage has the outcome fields
    const reviewStage = wire.stages.find((s: any) => s.name === 'review');
    expect(reviewStage).toBeDefined();
    expect(reviewStage.findingsOutcome).toBe('clean');
    expect(reviewStage.findingsOutcomeReason).toBeNull();
    expect(reviewStage.outcomeInferred).toBe(false);
    expect(reviewStage.outcomeMalformed).toBe(false);
  });

  it('projects outcome fields from annotating stage to wire row', () => {
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
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    // Check the annotating stage has the outcome fields
    const annStage = wire.stages.find((s: any) => s.name === 'annotating');
    expect(annStage).toBeDefined();
    expect(annStage.findingsOutcome).toBe('not_applicable');
    expect(annStage.findingsOutcomeReason).toBe('project-level question');
    expect(annStage.outcomeInferred).toBe(true);
    expect(annStage.outcomeMalformed).toBe(false);
  });

  it('omits outcome fields when not set on envelope stage', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage('implementing', 1, {
      outcome: 'advance',
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      // NO outcome fields set
    });
    s.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    const wire = toWireRecord(s.snapshot(), {
      reviewPolicy: 'full',
      toolMode: 'full',
      verifyCommandPresent: false,
      implementerModel: 'claude-sonnet-4-6',
      implementerTier: 'standard',
      mainModelFamily: 'claude',
    });

    expect(() => ValidatedTaskCompletedEventSchema.parse(wire)).not.toThrow();
    const implStage = wire.stages.find((s: any) => s.name === 'implementing');
    expect(implStage.findingsOutcome).toBeUndefined();
    expect(implStage.findingsOutcomeReason).toBeUndefined();
    expect(implStage.outcomeInferred).toBeUndefined();
    expect(implStage.outcomeMalformed).toBeUndefined();
  });
});
