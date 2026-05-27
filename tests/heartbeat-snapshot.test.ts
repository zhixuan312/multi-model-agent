import { describe, it, expect } from 'bun:test';
import { ActivityTracker } from '../packages/core/src/bounded-execution/activity-tracker.js';

describe('ActivityTracker.getHeadlineSnapshot', () => {
  it('emits prefix without elapsed and a stats clause that grows as filesWritten increments', () => {
    const ht = new ActivityTracker(() => {}, { provider: 'gpt-5', mainModel: null });
    ht.start(5);
    let snap = ht.getHeadlineSnapshot();
    expect(snap.prefix).toBe('[1/5] Implementing (gpt-5) — ');
    expect(snap.statsClause).toBe('');
    ht.updateProgress(1);
    snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toBe(', 1 written');
  });

  it('omits saved-cost clause when costDeltaVsMainUSD is zero', () => {
    const ht = new ActivityTracker(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0.01, costDeltaVsMainUSD: 0 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toBe(''); // counters all zero, savedCost zero
  });

  it('emits saved-cost clause with multiplier when costUSD is positive and costDeltaVsMainUSD is negative (savings)', () => {
    const ht = new ActivityTracker(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0.01, costDeltaVsMainUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).toContain('11.0x');
  });

  it('omits multiplier when costUSD is zero', () => {
    const ht = new ActivityTracker(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0, costDeltaVsMainUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).not.toContain('x');
  });

  it('omits multiplier when costUSD is non-finite', () => {
    const ht = new ActivityTracker(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: Infinity, costDeltaVsMainUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).not.toContain('x');
  });
});
