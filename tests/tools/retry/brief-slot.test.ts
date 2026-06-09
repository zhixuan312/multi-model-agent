import { describe, it, expect } from 'vitest';
import { retryBriefSlot } from '../../../packages/core/src/tools/retry/brief-slot.js';

describe('retryBriefSlot', () => {
  it('produces exactly one brief carrying the batchId (goal mode re-fires the whole goal-set)', () => {
    const briefs = retryBriefSlot({ batchId: 'batch-abc' } as any);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.batchId).toBe('batch-abc');
  });
});
