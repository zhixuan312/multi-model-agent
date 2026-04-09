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
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
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

  it('marks MiniMax-M2 as not supporting effort', () => {
    expect(findProfile('MiniMax-M2').supportsEffort).toBe(false);
  });

  it('marks unprofiled models as not supporting effort (conservative default)', () => {
    expect(findProfile('some-random-new-model').supportsEffort).toBe(false);
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
