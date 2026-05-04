import { describe, it, expect } from 'vitest';
import { resolveMainAgentModel } from '../../packages/core/src/config/load.js';
import type { Pricing } from '../../packages/core/src/config/load.js';

const shipped = new Map<string, Pricing>([
  ['claude-sonnet-4-5', { inputUSDPerMillion: 3, outputUSDPerMillion: 15, cachedReadUSDPerMillion: 0.3, cachedNonReadUSDPerMillion: 3.75 }],
]);

const userPricing: Pricing = { inputUSDPerMillion: 1, outputUSDPerMillion: 2, cachedReadUSDPerMillion: 0.1, cachedNonReadUSDPerMillion: 1.5 };

describe('resolveMainAgentModel', () => {
  it('case 1: known + no user pricing -> shipped', () => {
    const r = resolveMainAgentModel('claude-sonnet-4-5', undefined, shipped);
    expect(r.kind).toBe('shipped');
    if (r.kind === 'shipped') expect(r.pricing.inputUSDPerMillion).toBe(3);
  });

  it('case 2: known + user pricing -> shipped_overrides_user (shipped wins per spec line 659)', () => {
    const r = resolveMainAgentModel('claude-sonnet-4-5', userPricing, shipped);
    expect(r.kind).toBe('shipped_overrides_user');
    if (r.kind === 'shipped_overrides_user') {
      expect(r.pricing.inputUSDPerMillion).toBe(3);
      expect(r.warning).toContain('ignoring user value in favor of shipped pricing');
    }
  });

  it('case 3: unknown + user pricing -> user_for_unknown', () => {
    const r = resolveMainAgentModel('unknown-model-xyz', userPricing, shipped);
    expect(r.kind).toBe('user_for_unknown');
    if (r.kind === 'user_for_unknown') expect(r.pricing.inputUSDPerMillion).toBe(1);
  });

  it('case 4: unknown + no user pricing -> fail', () => {
    const r = resolveMainAgentModel('unknown-model-xyz', undefined, shipped);
    expect(r.kind).toBe('fail');
    if (r.kind === 'fail') expect(r.reason).toContain('unknown to shipped pricing');
  });
});
