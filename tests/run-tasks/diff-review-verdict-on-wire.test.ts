import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';
import type { RunResult } from '../../packages/core/src/types.js';
import { HAPPY } from '../telemetry/fixtures/runresult.js';

function makeFixture(overrides: Partial<RunResult>): RunResult {
  const rr = { ...structuredClone(HAPPY), ...overrides } as RunResult;
  rr.models = { implementer: 'claude-sonnet', specReviewer: 'gpt-4o', qualityReviewer: 'gpt-4o' };
  rr.stageStats = structuredClone(rr.stageStats)!;
  for (const stageName of ['spec_review', 'quality_review', 'diff_review'] as const) {
    rr.stageStats[stageName] = { ...rr.stageStats[stageName], model: 'gpt-4o', modelFamily: 'openai' } as any;
  }
  return rr;
}

describe('diff_review verdict on the wire', () => {
  it.each([
    ['approved', 'approved' as const],
    ['changes_required', 'changes_required' as const],
    ['skipped', 'skipped' as const],
    ['error', 'error' as const],
    ['not_applicable', 'not_applicable' as const],
  ])('emits diff_review.verdict=%s when RunResult.diffReviewStatus=%s', (_label, status) => {
    const rr = makeFixture({
      diffReviewStatus: status,
    });
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeDefined();
    expect(stage!.verdict).toBe(status);
  });

  it('emits diff_review.verdict=not_applicable when diffReviewStatus is absent', () => {
    const rr = makeFixture({});
    delete (rr as any).diffReviewStatus;
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeDefined();
    expect(stage!.verdict).toBe('not_applicable');
  });

  it('uses a valid single round for diff_review instead of metadata repair count', () => {
    const rr = makeFixture({
      diffReviewStatus: 'approved',
      reviewRounds: { spec: 1, quality: 1, metadata: 0, cap: 2 },
    });
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeDefined();
    expect(stage!.roundsUsed).toBe(1);
    expect(ValidatedTaskCompletedEventSchema.safeParse(event).success).toBe(true);
  });

  it('upgrades approved to concerns when stage concerns are non-empty', () => {
    const rr = makeFixture({
      diffReviewStatus: 'approved',
      concerns: [
        { source: 'diff_review', severity: 'medium', message: 'unexpected deletion' },
      ],
    });
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeDefined();
    expect(stage!.verdict).toBe('concerns');
    expect(ValidatedTaskCompletedEventSchema.safeParse(event).success).toBe(true);
  });

  it('emits changes_required for rejected diff reviews and validates the event schema', () => {
    const rr = makeFixture({
      diffReviewStatus: 'changes_required',
      status: 'error',
      workerStatus: 'failed',
      errorCode: 'diff_review_rejected',
      structuredError: { code: 'diff_review_rejected', message: 'diff review rejected implementation' },
      terminationReason: { cause: 'error', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'failed', wasPromoted: false },
    });
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeDefined();
    expect(stage!.verdict).toBe('changes_required');
    expect(ValidatedTaskCompletedEventSchema.safeParse(event).success).toBe(true);
  });

  it('does NOT emit diff_review on quality-only routes', () => {
    const rr = makeFixture({
      diffReviewStatus: 'approved',
    });
    const event = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      mainModel: null,
    });
    const stage = event.stages.find((s: any) => s.name === 'diff_review');
    expect(stage).toBeUndefined();
  });
});
