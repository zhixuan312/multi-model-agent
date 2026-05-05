import { describe, it, expect } from 'vitest';
import { resolveRateCard } from '../../packages/core/src/bounded-execution/cost-compute.js';

describe('resolveRateCard', () => {
  it('unknown model → null', () => {
    expect(resolveRateCard('totally-fake-model-xyz')).toBeNull();
  });

  it('null/undefined model → null', () => {
    expect(resolveRateCard(null)).toBeNull();
    expect(resolveRateCard(undefined)).toBeNull();
  });

  it('known anthropic model → card with explicit cachedNonReadCostPerMTok = input × 1.25', () => {
    const card = resolveRateCard('claude-opus-4-7');
    expect(card).not.toBeNull();
    expect(card!.cachedNonReadCostPerMTok).toBeCloseTo(card!.inputCostPerMTok * 1.25, 10);
  });

  it('known non-anthropic model → cachedNonReadCostPerMTok defaults to inputCostPerMTok (no premium)', () => {
    const card = resolveRateCard('gpt-5.5');
    expect(card).not.toBeNull();
    expect(card!.cachedNonReadCostPerMTok).toBeCloseTo(card!.inputCostPerMTok, 10);
  });

  it('cachedReadCostPerMTok defaults to input × 0.10 when profile omits it', () => {
    const card = resolveRateCard('deepseek-v4-pro');
    expect(card).not.toBeNull();
    expect(card!.cachedReadCostPerMTok).toBeCloseTo(card!.inputCostPerMTok * 0.10, 10);
  });

  it('reasoningCostPerMTok has been removed from rate cards (reasoning merged into output)', () => {
    const card = resolveRateCard('claude-sonnet-4-6');
    expect(card).not.toBeNull();
    expect((card as any).reasoningCostPerMTok).toBeUndefined();
  });

  it('override wins over profile and defaults', () => {
    const card = resolveRateCard('gpt-5.5', { cachedNonReadCostPerMTok: 99 });
    expect(card!.cachedNonReadCostPerMTok).toBe(99);
  });
});
