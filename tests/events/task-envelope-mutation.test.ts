// tests/events/task-envelope-mutation.test.ts
import { describe, it, expect, vi } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

const seed = { taskId: 't1', batchId: 'b1', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'full' as const };

describe('TaskEnvelopeStore mutations', () => {
  it('startStage appends a stage and notifies', () => {
    const notify = vi.fn();
    const s = TaskEnvelopeStore.create(seed, notify);
    notify.mockClear();
    s.startStage('implementing', { model: 'claude-sonnet-4-6', tier: 'standard' });
    expect(s.snapshot().stages).toHaveLength(1);
    expect(s.snapshot().stages[0].name).toBe('implementing');
    expect(notify).toHaveBeenCalledWith('startStage');
  });

  it('completeStage sets outcome + recomputes totals', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm1', tier: 'standard' });
    s.completeStage('implementing', 1, { outcome: 'advance', durationMs: 1000, costUSD: 0.05, turnsUsed: 3, inputTokens: 100, outputTokens: 50 });
    const snap = s.snapshot();
    expect(snap.stages[0].outcome).toBe('advance');
    expect(snap.totalCostUSD).toBe(0.05);
    expect(snap.totalDurationMs).toBe(1000);
    expect(snap.totalInputTokens).toBe(100);
    expect(snap.totalOutputTokens).toBe(50);
    expect(snap.turnsUsed).toBe(3);
  });

  it('recordToolCall updates files and stage counts', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.recordToolCall({ stage: 'implementing', tool: 'Read' });
    s.recordToolCall({ stage: 'implementing', tool: 'Edit', filesWritten: ['/a'] });
    const snap = s.snapshot();
    expect(snap.filesWritten).toEqual(['/a']);
    // toolTotal counts tool calls. Two recordToolCall invocations → 2.
    expect(snap.headline.toolTotal).toBe(2);
    expect(snap.headline.toolWrites).toBe(1); // /a
  });

  it('setPlannedStageTotal stabilizes headline.stageTotal as stages append', () => {
    const notify = vi.fn();
    const s = TaskEnvelopeStore.create(seed, notify);
    // Driver publishes the planned visible-stage total up front.
    s.setPlannedStageTotal(5);
    expect(notify).toHaveBeenCalledWith('setPlannedStageTotal');
    // Only one stage recorded so far, but the denominator reflects the plan.
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    expect(s.snapshot().headline).toMatchObject({ stageIndex: 1, stageTotal: 5 });
    // Reviewing started → ordinal advances to 2 even though implement is not
    // yet completed; the running stage counts toward stageIndex.
    s.startStage('reviewing', { model: 'm', tier: 'standard' });
    expect(s.snapshot().headline).toMatchObject({ stageIndex: 2, stageTotal: 5, stageLabel: 'reviewing' });
  });

  it('skipped stages do not advance stageIndex or inflate stageTotal (read-route shape)', () => {
    // Regression: read-only routes skip review/rework/commit. Those skipped
    // stages are still recorded in env.stages, but must NOT count toward the
    // progress ordinal/denominator — otherwise the headline jumped from
    // [1/2] to [5/5] as the skips were recorded.
    const s = TaskEnvelopeStore.create(seed);
    s.setPlannedStageTotal(2); // implement + annotate after the driver decrements skips
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.completeStage('implementing', 1, { outcome: 'advance', durationMs: 1 });
    expect(s.snapshot().headline).toMatchObject({ stageIndex: 1, stageTotal: 2 });
    // review/rework/commit skipped on a read route
    for (const name of ['reviewing', 'reworking', 'committing'] as const) {
      s.startStage(name, { model: 'm', tier: 'standard' });
      s.completeStage(name, 1, { outcome: 'skipped', durationMs: 0 });
    }
    // Denominator stays 2 and ordinal stays 1 — skips don't count.
    expect(s.snapshot().headline).toMatchObject({ stageIndex: 1, stageTotal: 2 });
    // The one remaining real stage advances the ordinal to 2 of 2.
    s.startStage('annotating', { model: 'm', tier: 'standard' });
    expect(s.snapshot().headline).toMatchObject({ stageIndex: 2, stageTotal: 2, stageLabel: 'annotating' });
  });

  it('headline.stageTotal exceeds planned total when rework adds rounds', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.setPlannedStageTotal(2);
    for (const name of ['implementing', 'reviewing', 'reworking'] as const) {
      s.startStage(name, { model: 'm', tier: 'standard' });
    }
    // Three recorded stages outgrow the planned 2 → max() reports the truth.
    expect(s.snapshot().headline.stageTotal).toBe(3);
  });

  it('headline.stageTotal falls back to recorded count when total unpublished', () => {
    const s = TaskEnvelopeStore.create(seed);
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    s.startStage('reviewing', { model: 'm', tier: 'standard' });
    // plannedStageTotal stays 0 (non-lifecycle envelope) → recorded count.
    expect(s.snapshot().headline.stageTotal).toBe(2);
  });

  it('snapshot returns immutable deep clone', () => {
    const s = TaskEnvelopeStore.create(seed);
    const snap = s.snapshot();
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    expect(snap.stages).toHaveLength(0);
    expect(s.snapshot().stages).toHaveLength(1);
  });
});
