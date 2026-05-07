import type { TokenUsage } from '../providers/runner-types.js';

export interface StageLike extends TokenUsage {
  tier: 'standard' | 'complex';
  model: string;
  costUSD: number | null;
}

export interface TierUsage extends TokenUsage {
  model: string;
  costUSD: number | null;
}

export type TierRollup = {
  standard?: TierUsage;
  complex?:  TierUsage;
};

export function sumTokens(stages: ReadonlyArray<TokenUsage>): TokenUsage {
  const acc: TokenUsage = {
    inputTokens: 0, outputTokens: 0,
    cachedReadTokens: 0, cachedNonReadTokens: 0,
  };
  for (const s of stages) {
    acc.inputTokens          += s.inputTokens;
    acc.outputTokens         += s.outputTokens;
    acc.cachedReadTokens     += s.cachedReadTokens;
    acc.cachedNonReadTokens  += s.cachedNonReadTokens;
  }
  return acc;
}

export function rollupByTier(stages: ReadonlyArray<StageLike>): TierRollup {
  const out: TierRollup = {};
  for (const s of stages) {
    const cur = out[s.tier];
    if (!cur) {
      out[s.tier] = {
        model: s.model,
        costUSD: s.costUSD,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cachedReadTokens: s.cachedReadTokens,
        cachedNonReadTokens: s.cachedNonReadTokens,
      };
    } else {
      cur.model = s.model; // last-seen
      cur.inputTokens          += s.inputTokens;
      cur.outputTokens         += s.outputTokens;
      cur.cachedReadTokens     += s.cachedReadTokens;
      cur.cachedNonReadTokens  += s.cachedNonReadTokens;
      // honest-null: any contributing null poisons the tier total
      cur.costUSD = (cur.costUSD === null || s.costUSD === null) ? null : cur.costUSD + s.costUSD;
    }
  }
  return out;
}
