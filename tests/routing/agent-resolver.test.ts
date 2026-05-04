import { describe, it, expect } from 'vitest';
import { AgentResolver } from '../../packages/core/src/routing/agent-resolver.js';
import type { TierModelProfile } from '../../packages/core/src/routing/agent-resolver.js';

const standardProfile: TierModelProfile = {
  model: 'claude-sonnet-4-6',
  pricing: {
    inputUSDPerMillion: 3,
    outputUSDPerMillion: 15,
    cachedReadUSDPerMillion: 0.3,
    cachedNonReadUSDPerMillion: 3.75,
  },
};

const complexProfile: TierModelProfile = {
  model: 'claude-opus-4-7',
  pricing: {
    inputUSDPerMillion: 15,
    outputUSDPerMillion: 75,
    cachedReadUSDPerMillion: 1.5,
    cachedNonReadUSDPerMillion: 18.75,
  },
};

describe('AgentResolver', () => {
  it('resolves tier to single model', () => {
    const profiles = new Map([
      ['standard', standardProfile],
    ]);
    const r = new AgentResolver(profiles);
    expect(r.resolve('standard').model).toBe('claude-sonnet-4-6');
  });

  it('resolves complex tier', () => {
    const profiles = new Map([
      ['standard', standardProfile],
      ['complex', complexProfile],
    ]);
    const r = new AgentResolver(profiles);
    const result = r.resolve('complex');
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.pricing.inputUSDPerMillion).toBe(15);
  });

  it('returns pricing alongside model', () => {
    const profiles = new Map([
      ['standard', standardProfile],
    ]);
    const r = new AgentResolver(profiles);
    const result = r.resolve('standard');
    expect(result.pricing.inputUSDPerMillion).toBe(3);
    expect(result.pricing.outputUSDPerMillion).toBe(15);
    expect(result.pricing.cachedReadUSDPerMillion).toBe(0.3);
    expect(result.pricing.cachedNonReadUSDPerMillion).toBe(3.75);
  });

  it('throws when tier is not in the map', () => {
    const profiles = new Map([
      ['standard', standardProfile],
    ]);
    const r = new AgentResolver(profiles);
    expect(() => r.resolve('complex')).toThrow("no profile for tier 'complex'");
  });
});
