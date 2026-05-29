import { describe, it, expect } from 'bun:test';
import { retryBriefSlot } from '../../../packages/core/src/tools/retry/brief-slot.js';

describe('retryBriefSlot', () => {
  it('produces one brief per task index', () => {
    const briefs = retryBriefSlot({
      batchId: 'batch-abc',
      taskIndices: [0, 2, 5],
    } as any);
    expect(briefs).toHaveLength(3);
  });

  it('carries batchId on every brief', () => {
    const briefs = retryBriefSlot({
      batchId: 'batch-xyz',
      taskIndices: [1, 2],
    } as any);
    expect(briefs[0].batchId).toBe('batch-xyz');
    expect(briefs[1].batchId).toBe('batch-xyz');
  });

  it('forwards taskIndex on each brief', () => {
    const briefs = retryBriefSlot({
      batchId: 'b',
      taskIndices: [7, 11, 13],
    } as any);
    expect(briefs.map(b => b.taskIndex)).toEqual([7, 11, 13]);
  });

  it('returns empty array when taskIndices is empty', () => {
    const briefs = retryBriefSlot({
      batchId: 'b',
      taskIndices: [],
    } as any);
    expect(briefs).toEqual([]);
  });
});
