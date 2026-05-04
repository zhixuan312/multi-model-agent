import { describe, it, expect } from 'vitest';
import { HeartbeatTimer } from '../packages/core/src/heartbeat.js';

describe('HeartbeatTimer.getHeadlineSnapshot', () => {
  it('emits prefix without elapsed and a stats clause that grows as counters fire', () => {
    const ht = new HeartbeatTimer(() => {}, { provider: 'gpt-5', mainModel: null });
    ht.start(5);
    let snap = ht.getHeadlineSnapshot();
    expect(snap.prefix).toBe('[1/5] Implementing (gpt-5) — ');
    expect(snap.statsClause).toBe('');
    ht.recordToolCall();
    ht.recordFileRead();
    snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toBe(', 1 read, 1 tool call');
  });

  it('omits saved-cost clause when costDeltaVsParentUSD is zero', () => {
    const ht = new HeartbeatTimer(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0.01, costDeltaVsParentUSD: 0 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toBe(''); // counters all zero, savedCost zero
  });

  it('emits saved-cost clause with multiplier when costUSD is positive and costDeltaVsParentUSD is negative (savings)', () => {
    const ht = new HeartbeatTimer(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0.01, costDeltaVsParentUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).toContain('11.0x');
  });

  it('omits multiplier when costUSD is zero', () => {
    const ht = new HeartbeatTimer(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: 0, costDeltaVsParentUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).not.toContain('x');
  });

  it('omits multiplier when costUSD is non-finite', () => {
    const ht = new HeartbeatTimer(() => {}, { provider: 'gpt-5', mainModel: 'claude-opus-4-7' });
    ht.start(5);
    ht.applyCost({ costUSD: Infinity, costDeltaVsParentUSD: -0.10 });
    const snap = ht.getHeadlineSnapshot();
    expect(snap.statsClause).toContain('$0.10 saved');
    expect(snap.statsClause).not.toContain('x');
  });
});
