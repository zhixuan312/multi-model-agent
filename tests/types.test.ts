import { computeCostDeltaVsParentUSD } from '../packages/core/src/types.js';

describe('computeCostDeltaVsParentUSD', () => {
  it('returns positive delta when worker cost > parent cost', () => {
    // worker = $5.27, parent (claude-opus-4-7 at fixture rates) = $5.24
    const delta = computeCostDeltaVsParentUSD(5.27, 1_023_732, 5346, 'claude-opus-4-7');
    expect(delta).toBeGreaterThan(0);
  });
  it('returns negative delta when worker cost < parent cost', () => {
    // worker = haiku-rate cost, parent = opus-rate cost
    const delta = computeCostDeltaVsParentUSD(1.0, 1_000_000, 5000, 'claude-opus-4-7');
    expect(delta).toBeLessThan(0);
  });
  it('returns null when actualCostUSD is null', () => {
    expect(computeCostDeltaVsParentUSD(null, 1000, 100, 'claude-opus-4-7')).toBeNull();
  });
  it('returns null when parentModel is undefined', () => {
    expect(computeCostDeltaVsParentUSD(1.0, 1000, 100, undefined)).toBeNull();
  });
  it('returns null when cachedTokens or reasoningTokens is null (honest-null per §3.6)', () => {
    // Only cached/reasoning are nullable per §3.6 — input/output tokens are always numbers.
    expect(computeCostDeltaVsParentUSD(1.0, 1000, 100, 'claude-opus-4-7', null, 0)).toBeNull();
    expect(computeCostDeltaVsParentUSD(1.0, 1000, 100, 'claude-opus-4-7', 0, null)).toBeNull();
    // Both null → still null
    expect(computeCostDeltaVsParentUSD(1.0, 1000, 100, 'claude-opus-4-7', null, null)).toBeNull();
  });
  it('returns numeric delta when both nullable dimensions are concrete numbers (incl. 0)', () => {
    // 0 is a concrete number, distinct from null (§3.6 gap signal)
    expect(typeof computeCostDeltaVsParentUSD(1.0, 1000, 100, 'claude-opus-4-7', 0, 0)).toBe('number');
  });
});
