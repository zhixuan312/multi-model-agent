// tests/events/task-envelope-mutation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

const seed = { taskId: 't1', batchId: 'b1', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'reviewed' as const };

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
    expect(snap.toolCalls.map((t) => t.tool)).toEqual(['Read', 'Edit']);
  });

  // Four tests stood here, all of them about `headline.stageIndex` / `headline.stageTotal`:
  // a planned total stabilising the denominator, skipped stages not advancing the ordinal, rework
  // rounds outgrowing the plan, and a fallback when no total was published. None of it ran in
  // production. The sole producer of a real envelope wrote the headline as a constant literal and
  // nothing read it, so `max(planned, recorded)`, the skipped-stage filter, and the fallback were
  // all branches only this fixture could reach. The field is gone; see `task-envelope.ts` for why.

  it('snapshot returns immutable deep clone', () => {
    const s = TaskEnvelopeStore.create(seed);
    const snap = s.snapshot();
    s.startStage('implementing', { model: 'm', tier: 'standard' });
    expect(snap.stages).toHaveLength(0);
    expect(s.snapshot().stages).toHaveLength(1);
  });
});
