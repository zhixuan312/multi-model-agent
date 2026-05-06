import { describe, it, expect } from 'vitest';
import { findModelProfile } from '../../packages/core/src/config/model-profile-registry.js';

const ANTHROPIC_MODELS = [
  'claude-opus', 'claude-sonnet', 'claude-haiku',
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'claude-opus-4-1',
  'claude-3-opus', 'claude-3-haiku',
];

describe('Anthropic profile completeness', () => {
  it.each(ANTHROPIC_MODELS)('%s has cachedNonReadCostPerMTok ≈ inputCostPerMTok × 1.25', (model) => {
    const profile = findModelProfile(model);
    expect(profile.inputCostPerMTok).toBeDefined();
    expect(profile.cachedNonReadCostPerMTok).toBeDefined();
    expect(profile.cachedNonReadCostPerMTok!).toBeCloseTo(profile.inputCostPerMTok! * 1.25, 6);
  });
});
