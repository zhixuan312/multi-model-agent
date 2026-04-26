import { describe, it, expect } from 'vitest';
import {
  bucketCost, bucketSavedCost, bucketDuration, bucketFileCount, bucketRoundsUsed,
} from '../../packages/core/src/telemetry/bucketing.js';

describe('bucketing — every boundary explicitly tested', () => {
  // costBucket
  it('bucketCost: $0', () => expect(bucketCost(0)).toBe('$0'));
  it('bucketCost: 0.0001 → <$0.01', () => expect(bucketCost(0.0001)).toBe('<$0.01'));
  it('bucketCost: 0.0099 → <$0.01', () => expect(bucketCost(0.0099)).toBe('<$0.01'));
  it('bucketCost: 0.01 → $0.01-$0.10', () => expect(bucketCost(0.01)).toBe('$0.01-$0.10'));
  it('bucketCost: 0.0999 → $0.01-$0.10', () => expect(bucketCost(0.0999)).toBe('$0.01-$0.10'));
  it('bucketCost: 0.10 → $0.10-$1', () => expect(bucketCost(0.10)).toBe('$0.10-$1'));
  it('bucketCost: 0.999 → $0.10-$1', () => expect(bucketCost(0.999)).toBe('$0.10-$1'));
  it('bucketCost: 1.00 → $1+', () => expect(bucketCost(1)).toBe('$1+'));
  it('bucketCost: 1000 → $1+', () => expect(bucketCost(1000)).toBe('$1+'));
  it('bucketCost: negative → $0 (upstream-bug guard)', () => expect(bucketCost(-0.05)).toBe('$0'));
  it('bucketCost: NaN → $0', () => expect(bucketCost(NaN)).toBe('$0'));
  it('bucketCost: Infinity → $0 (non-finite → upstream-bug guard)', () => expect(bucketCost(Infinity)).toBe('$0'));

  // savedCostBucket
  it('bucketSavedCost: null → unknown', () => expect(bucketSavedCost(null)).toBe('unknown'));
  it('bucketSavedCost: 0 → $0', () => expect(bucketSavedCost(0)).toBe('$0'));
  it('bucketSavedCost: 0.099 → <$0.10', () => expect(bucketSavedCost(0.099)).toBe('<$0.10'));
  it('bucketSavedCost: 0.10 → $0.10-$1', () => expect(bucketSavedCost(0.10)).toBe('$0.10-$1'));
  it('bucketSavedCost: 1.00 → $1+', () => expect(bucketSavedCost(1)).toBe('$1+'));
  it('bucketSavedCost: -0.50 → $0 (upstream-bug guard)', () => expect(bucketSavedCost(-0.5)).toBe('$0'));
  it('bucketSavedCost: NaN → $0', () => expect(bucketSavedCost(NaN)).toBe('$0'));

  // durationBucket (ms)
  it('bucketDuration: 0 → <10s', () => expect(bucketDuration(0)).toBe('<10s'));
  it('bucketDuration: 9999 → <10s', () => expect(bucketDuration(9_999)).toBe('<10s'));
  it('bucketDuration: 10_000 → 10s-1m', () => expect(bucketDuration(10_000)).toBe('10s-1m'));
  it('bucketDuration: 60_000 → 1m-5m', () => expect(bucketDuration(60_000)).toBe('1m-5m'));
  it('bucketDuration: 300_000 → 5m-30m', () => expect(bucketDuration(300_000)).toBe('5m-30m'));
  it('bucketDuration: 1_800_000 → 30m+', () => expect(bucketDuration(1_800_000)).toBe('30m+'));

  // fileCountBucket
  it('bucketFileCount: 0 → 0', () => expect(bucketFileCount(0)).toBe('0'));
  it('bucketFileCount: 1 → 1-5', () => expect(bucketFileCount(1)).toBe('1-5'));
  it('bucketFileCount: 5 → 1-5', () => expect(bucketFileCount(5)).toBe('1-5'));
  it('bucketFileCount: 6 → 6-20', () => expect(bucketFileCount(6)).toBe('6-20'));
  it('bucketFileCount: 51 → 51+', () => expect(bucketFileCount(51)).toBe('51+'));

  // roundsUsed
  it('bucketRoundsUsed: 0 → "0"', () => expect(bucketRoundsUsed(0)).toBe('0'));
  it('bucketRoundsUsed: 1 → "1"', () => expect(bucketRoundsUsed(1)).toBe('1'));
  it('bucketRoundsUsed: 2 → "2+"', () => expect(bucketRoundsUsed(2)).toBe('2+'));
  it('bucketRoundsUsed: 99 → "2+"', () => expect(bucketRoundsUsed(99)).toBe('2+'));
});
