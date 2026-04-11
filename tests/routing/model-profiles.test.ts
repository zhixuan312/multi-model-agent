import { describe, it, expect } from 'vitest';
import { findModelProfile, getEffectiveCostTier, modelProfileSchema } from '../../packages/core/src/routing/model-profiles.js';
import type { ProviderConfig } from '../../packages/core/src/types.js';

describe('findModelProfile', () => {
  it('matches claude-opus family by prefix', () => {
    const profile = findModelProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning');
    expect(profile.defaultCost).toBe('high');
  });

  it('matches claude-sonnet family by prefix', () => {
    const profile = findModelProfile('claude-sonnet-4-5');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
  });

  it('matches gpt-5 family by prefix', () => {
    const profile = findModelProfile('gpt-5-codex');
    expect(profile.tier).toBe('reasoning');
    expect(profile.defaultCost).toBe('medium');
  });


  it('matches MiniMax-M2 exactly', () => {
    const profile = findModelProfile('MiniMax-M2');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('low');
    expect(profile.avoidFor).toBeDefined();
  });

  it('exposes pricing metadata for rate-backed profiles', () => {
    const profile = findModelProfile('gpt-5-codex');
    expect(profile.inputCostPerMTok).toBe(1.25);
    expect(profile.outputCostPerMTok).toBe(10);
    expect(profile.rateSource).toMatch(/OpenAI/i);
    expect(profile.rateLookupDate).toBe('2026-04-11');
  });

  it('leaves pricing metadata undefined for MiniMax-M2', () => {
    const profile = findModelProfile('MiniMax-M2');
    expect(profile.inputCostPerMTok).toBeUndefined();
    expect(profile.outputCostPerMTok).toBeUndefined();
    expect(profile.rateSource).toBeUndefined();
    expect(profile.rateLookupDate).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const profile = findModelProfile('CLAUDE-OPUS-4-6');
    expect(profile.tier).toBe('reasoning');
  });

  it('falls back to default profile for unknown models', () => {
    const profile = findModelProfile('llama-3-70b');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
    expect(profile.bestFor).toMatch(/unprofiled/);
  });

  it('prefers the longest matching prefix', () => {
    // Both 'claude-opus' and 'claude-sonnet' exist; 'claude-opus-4-6' must match claude-opus
    const profile = findModelProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning'); // opus tier, not sonnet
  });

  it('marks claude-opus as supporting effort', () => {
    expect(findModelProfile('claude-opus-4-6').supportsEffort).toBe(true);
  });

  it('marks claude-sonnet as supporting effort', () => {
    expect(findModelProfile('claude-sonnet-4-5').supportsEffort).toBe(true);
  });

  it('marks gpt-5 as supporting effort', () => {
    expect(findModelProfile('gpt-5-codex').supportsEffort).toBe(true);
  });

  it('marks MiniMax-M2 as supporting effort', () => {
    expect(findModelProfile('MiniMax-M2').supportsEffort).toBe(true);
  });

  it('marks unprofiled models as not supporting effort (conservative default)', () => {
    expect(findModelProfile('some-random-new-model').supportsEffort).toBe(false);
  });

  describe('inputTokenSoftLimit field', () => {
    it('exposes the per-family soft limit on known profiles', () => {
      expect(findModelProfile('gpt-5-codex').inputTokenSoftLimit).toBe(1_000_000);
      expect(findModelProfile('claude-sonnet-4-5').inputTokenSoftLimit).toBe(150_000);
      expect(findModelProfile('claude-opus-4-6').inputTokenSoftLimit).toBe(150_000);
      expect(findModelProfile('MiniMax-M2').inputTokenSoftLimit).toBe(200_000);
    });

    it('falls back to 100_000 for unprofiled models (conservative default)', () => {
      expect(findModelProfile('llama-3-70b').inputTokenSoftLimit).toBe(100_000);
    });

    it('falls back to DEFAULT_PROFILE (100_000) for claude-haiku since no haiku profile exists', () => {
      expect(findModelProfile('claude-haiku').inputTokenSoftLimit).toBe(100_000);
    });

    it('falls back to claude-opus profile (150_000) for claude-opus-4-6[1m] since no [1m] profile exists', () => {
      // Matches "claude-opus" prefix, so it inherits the 150_000 opus limit, not a dedicated [1m] override.
      expect(findModelProfile('claude-opus-4-6[1m]').inputTokenSoftLimit).toBe(150_000);
    });
  });

  describe('modelProfileSchema', () => {
    it('accepts rate metadata when present', () => {
      expect(
        modelProfileSchema.safeParse({
          prefix: 'gpt-5',
          tier: 'reasoning',
          defaultCost: 'medium',
          bestFor: 'reasoning-tier coding, agentic workflows, and tool use',
          avoidFor: 'cases where you explicitly prefer premium escalation over cost or latency',
          supportsEffort: true,
          inputTokenSoftLimit: 1_000_000,
          inputCostPerMTok: 1.25,
          outputCostPerMTok: 10,
          rateSource: 'OpenAI pricing',
          rateLookupDate: '2026-04-11',
        }).success,
      ).toBe(true);
    });

    it('accepts profiles without rate metadata', () => {
      expect(
        modelProfileSchema.safeParse({
          prefix: 'MiniMax-M2',
          tier: 'standard',
          defaultCost: 'low',
          bestFor: 'well-scoped coding and agent loops where cost matters',
          avoidFor: 'highest-stakes ambiguous work that needs top-tier judgment',
          supportsEffort: true,
          inputTokenSoftLimit: 200_000,
        }).success,
      ).toBe(true);
    });
  });

  // Version-tolerance regression tests: users may configure any minor/patch
  // version of a known family. The matcher should map all of them to the
  // family profile so users do not have to maintain a manual map.
  describe('family-prefix version tolerance', () => {
    it('matches claude-opus across minor versions (4-5, 4-6, 5)', () => {
      expect(findModelProfile('claude-opus-4-5').tier).toBe('reasoning');
      expect(findModelProfile('claude-opus-4-6').tier).toBe('reasoning');
      expect(findModelProfile('claude-opus-5').tier).toBe('reasoning');
      expect(findModelProfile('claude-opus-3').tier).toBe('reasoning');
    });

    it('matches claude-sonnet across minor versions', () => {
      expect(findModelProfile('claude-sonnet-3-5').tier).toBe('standard');
      expect(findModelProfile('claude-sonnet-4-5').tier).toBe('standard');
    });

    it('matches gpt-5 across decimal and suffix variations', () => {
      expect(findModelProfile('gpt-5').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5-codex').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5.1').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5.2').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5.3').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5.4').tier).toBe('reasoning');
      expect(findModelProfile('gpt-5-turbo').tier).toBe('reasoning');
    });

    it('matches MiniMax-M2 across decimal variations', () => {
      expect(findModelProfile('MiniMax-M2').defaultCost).toBe('low');
      expect(findModelProfile('MiniMax-M2.7').defaultCost).toBe('low');
      expect(findModelProfile('MiniMax-M2.1').defaultCost).toBe('low');
      expect(findModelProfile('minimax-m2.5').defaultCost).toBe('low');
    });

    it('falls back to default for non-canonical forms that lack the family prefix', () => {
      // Without 'claude-' prefix, not a match
      expect(findModelProfile('opus-4-6').bestFor).toMatch(/unprofiled/);
      // Dot separator instead of hyphen between 'gpt' and '5'
      expect(findModelProfile('gpt.5.3').bestFor).toMatch(/unprofiled/);
    });
  });
});

describe('getEffectiveCostTier', () => {
  it('returns config costTier override when present', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      costTier: 'free',
    };
    expect(getEffectiveCostTier(config)).toBe('free');
  });

  it('falls back to profile defaultCost when override absent', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
    };
    expect(getEffectiveCostTier(config)).toBe('high');
  });

  it('falls back to default profile cost for unknown model without override', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'something-new',
      baseUrl: 'https://api.example.com/v1',
    };
    expect(getEffectiveCostTier(config)).toBe('medium');
  });
});
