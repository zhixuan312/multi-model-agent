import { describe, it, expect } from 'vitest';
import { findProfile, effectiveCost } from '../../src/routing/model-profiles.js';
import type { ProviderConfig } from '../../src/types.js';

describe('findProfile', () => {
  it('matches claude-opus family by prefix', () => {
    const profile = findProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning');
    expect(profile.defaultCost).toBe('high');
  });

  it('matches claude-sonnet family by prefix', () => {
    const profile = findProfile('claude-sonnet-4-5');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
  });

  it('matches gpt-5 family by prefix', () => {
    const profile = findProfile('gpt-5-codex');
    expect(profile.tier).toBe('reasoning');
    expect(profile.defaultCost).toBe('medium');
  });

  it('includes optional notes on gpt-5 clarifying tool dependency', () => {
    const profile = findProfile('gpt-5-codex');
    expect(profile.notes).toBeDefined();
    expect(profile.notes).toMatch(/web\/tool support/);
  });

  it('matches MiniMax-M2 exactly', () => {
    const profile = findProfile('MiniMax-M2');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('low');
    expect(profile.avoidFor).toBeDefined();
  });

  it('is case-insensitive', () => {
    const profile = findProfile('CLAUDE-OPUS-4-6');
    expect(profile.tier).toBe('reasoning');
  });

  it('falls back to default profile for unknown models', () => {
    const profile = findProfile('llama-3-70b');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
    expect(profile.bestFor).toMatch(/unprofiled/);
  });

  it('prefers the longest matching prefix', () => {
    // Both 'claude-opus' and 'claude-sonnet' exist; 'claude-opus-4-6' must match claude-opus
    const profile = findProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning'); // opus tier, not sonnet
  });

  it('marks claude-opus as supporting effort', () => {
    expect(findProfile('claude-opus-4-6').supportsEffort).toBe(true);
  });

  it('marks claude-sonnet as supporting effort', () => {
    expect(findProfile('claude-sonnet-4-5').supportsEffort).toBe(true);
  });

  it('marks gpt-5 as supporting effort', () => {
    expect(findProfile('gpt-5-codex').supportsEffort).toBe(true);
  });

  it('marks MiniMax-M2 as supporting effort', () => {
    expect(findProfile('MiniMax-M2').supportsEffort).toBe(true);
  });

  it('marks unprofiled models as not supporting effort (conservative default)', () => {
    expect(findProfile('some-random-new-model').supportsEffort).toBe(false);
  });

  // Version-tolerance regression tests: users may configure any minor/patch
  // version of a known family. The matcher should map all of them to the
  // family profile so users do not have to maintain a manual map.
  describe('family-prefix version tolerance', () => {
    it('matches claude-opus across minor versions (4-5, 4-6, 5)', () => {
      expect(findProfile('claude-opus-4-5').tier).toBe('reasoning');
      expect(findProfile('claude-opus-4-6').tier).toBe('reasoning');
      expect(findProfile('claude-opus-5').tier).toBe('reasoning');
      expect(findProfile('claude-opus-3').tier).toBe('reasoning');
    });

    it('matches claude-sonnet across minor versions', () => {
      expect(findProfile('claude-sonnet-3-5').tier).toBe('standard');
      expect(findProfile('claude-sonnet-4-5').tier).toBe('standard');
    });

    it('matches gpt-5 across decimal and suffix variations', () => {
      expect(findProfile('gpt-5').tier).toBe('reasoning');
      expect(findProfile('gpt-5-codex').tier).toBe('reasoning');
      expect(findProfile('gpt-5.1').tier).toBe('reasoning');
      expect(findProfile('gpt-5.2').tier).toBe('reasoning');
      expect(findProfile('gpt-5.3').tier).toBe('reasoning');
      expect(findProfile('gpt-5.4').tier).toBe('reasoning');
      expect(findProfile('gpt-5-turbo').tier).toBe('reasoning');
    });

    it('matches MiniMax-M2 across decimal variations', () => {
      expect(findProfile('MiniMax-M2').defaultCost).toBe('low');
      expect(findProfile('MiniMax-M2.7').defaultCost).toBe('low');
      expect(findProfile('MiniMax-M2.1').defaultCost).toBe('low');
      expect(findProfile('minimax-m2.5').defaultCost).toBe('low');
    });

    it('falls back to default for non-canonical forms that lack the family prefix', () => {
      // Without 'claude-' prefix, not a match
      expect(findProfile('opus-4-6').bestFor).toMatch(/unprofiled/);
      // Dot separator instead of hyphen between 'gpt' and '5'
      expect(findProfile('gpt.5.3').bestFor).toMatch(/unprofiled/);
    });
  });
});

describe('effectiveCost', () => {
  it('returns config costTier override when present', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      costTier: 'free',
    };
    expect(effectiveCost(config)).toBe('free');
  });

  it('falls back to profile defaultCost when override absent', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
    };
    expect(effectiveCost(config)).toBe('high');
  });

  it('falls back to default profile cost for unknown model without override', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'something-new',
      baseUrl: 'https://api.example.com/v1',
    };
    expect(effectiveCost(config)).toBe('medium');
  });
});
