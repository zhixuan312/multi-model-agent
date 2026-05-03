import { describe, it, expect } from 'vitest';
import { resolveRateCard } from '../../packages/core/src/cost/compute.js';

describe('resolveRateCard', () => {
  it('unknown model → null', () => {
    expect(resolveRateCard('totally-fake-model-xyz')).toBeNull();
  });

  it('null/undefined model → null', () => {
    expect(resolveRateCard(null)).toBeNull();
    expect(resolveRateCard(undefined)).toBeNull();
  });

  it.skip('known anthropic model → card with explicit cachedCreationCostPerMTok = input × 1.25', () => {
    const card = resolveRateCard('claude-opus-4-7');
    expect(card).not.toBeNull();
    expect(card!.cachedCreationCostPerMTok).toBeCloseTo(card!.inputCostPerMTok * 1.25, 10);
  });

  it.skip('known non-anthropic model → cachedCreationCostPerMTok defaults to inputCostPerMTok (no premium)', () => {
    const card = resolveRateCard('gpt-5.5');
    expect(card).not.toBeNull();
    expect(card!.cachedCreationCostPerMTok).toBeCloseTo(card!.inputCostPerMTok, 10);
  });

  it('cachedReadCostPerMTok defaults to input × 0.10 when profile omits it', () => {
    const card = resolveRateCard('deepseek-v4-pro');
    expect(card).not.toBeNull();
    expect(card!.cachedReadCostPerMTok).toBeCloseTo(card!.inputCostPerMTok * 0.10, 10);
  });

  it('reasoningCostPerMTok defaults to outputCostPerMTok', () => {
    const card = resolveRateCard('claude-sonnet-4-6');
    expect(card).not.toBeNull();
    expect(card!.reasoningCostPerMTok).toBe(card!.outputCostPerMTok);
  });

  it('override wins over profile and defaults', () => {
    const card = resolveRateCard('gpt-5.5', { cachedCreationCostPerMTok: 99 });
    expect(card!.cachedCreationCostPerMTok).toBe(99);
  });
});
