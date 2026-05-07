import { describe, it, expect } from 'vitest';
import { rollupByTier, sumTokens } from '../../packages/core/src/bounded-execution/cost-rollup.js';
import type { TokenUsage } from '../../packages/core/src/providers/runner-types.js';

type StageLike = TokenUsage & {
  tier: 'standard' | 'complex';
  model: string;
  costUSD: number | null;
};

const makeStage = (tier: StageLike['tier'], model: string, t: Partial<TokenUsage>, cost: number | null): StageLike => ({
  tier, model, costUSD: cost,
  inputTokens: t.inputTokens ?? 0, outputTokens: t.outputTokens ?? 0,
  cachedReadTokens: t.cachedReadTokens ?? 0, cachedNonReadTokens: t.cachedNonReadTokens ?? 0,
});

describe('sumTokens', () => {
  it('empty array → all zeros', () => {
    expect(sumTokens([])).toEqual({
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    });
  });
  it('sums each field independently', () => {
    const stages = [
      makeStage('standard', 'a', { inputTokens: 100, cachedReadTokens: 10 }, 0.01),
      makeStage('complex',  'b', { inputTokens: 200, cachedReadTokens: 20 }, 0.02),
    ];
    const t = sumTokens(stages);
    expect(t.inputTokens).toBe(300);
    expect(t.cachedReadTokens).toBe(30);
  });
});

describe('rollupByTier', () => {
  it('empty stages → empty object', () => {
    expect(rollupByTier([])).toEqual({});
  });
  it('single-tier task → one key, costUSD sums', () => {
    const stages = [
      makeStage('standard', 'deepseek-v4-pro', { inputTokens: 100 }, 0.01),
      makeStage('standard', 'deepseek-v4-pro', { inputTokens: 200 }, 0.02),
    ];
    const r = rollupByTier(stages);
    expect(r.standard).toBeDefined();
    expect(r.standard!.inputTokens).toBe(300);
    expect(r.standard!.costUSD).toBeCloseTo(0.03, 10);
    expect(r.standard!.model).toBe('deepseek-v4-pro');
    expect(r.complex).toBeUndefined();
  });
  it('mixed-tier with rework rounds — tier swap on round 2', () => {
    const stages = [
      makeStage('standard', 'deepseek-v4-pro', { inputTokens: 1000, outputTokens: 100 }, 0.10),
      makeStage('complex',  'gpt-5.5',         { inputTokens: 500,  outputTokens: 50  }, 0.20),
      makeStage('complex',  'gpt-5.5',         { inputTokens: 600,  outputTokens: 60  }, 0.25),
      makeStage('standard', 'deepseek-v4-pro', { inputTokens: 700,  outputTokens: 70  }, 0.07),
      makeStage('complex',  'gpt-5.5',         { inputTokens: 800,  outputTokens: 80  }, 0.32),
    ];
    const r = rollupByTier(stages);
    expect(r.standard!.inputTokens).toBe(1700);
    expect(r.standard!.costUSD).toBeCloseTo(0.17, 10);
    expect(r.complex!.inputTokens).toBe(1900);
    expect(r.complex!.costUSD).toBeCloseTo(0.77, 10);
    expect(r.complex!.model).toBe('gpt-5.5');
  });
  it('null costUSD propagates to tier (honest-null)', () => {
    const stages = [
      makeStage('standard', 'a', { inputTokens: 100 }, 0.01),
      makeStage('standard', 'a', { inputTokens: 100 }, null),
    ];
    const r = rollupByTier(stages);
    expect(r.standard!.costUSD).toBeNull();
  });
});
