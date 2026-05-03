import type { TokenCounts } from './compute.js';

export interface StageLike extends TokenCounts {
  tier: 'standard' | 'complex' | 'main';
  model: string;
  costUSD: number | null;
}

export interface TierUsage extends TokenCounts {
  model: string;
  costUSD: number | null;
}

export type TierRollup = {
  standard?: TierUsage;
  complex?:  TierUsage;
  main?:     TierUsage;
};

export function sumTokens(stages: ReadonlyArray<TokenCounts>): TokenCounts {
  const acc: TokenCounts = {
    inputTokens: 0, outputTokens: 0,
    cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
  };
  for (const s of stages) {
    acc.inputTokens          += s.inputTokens;
    acc.outputTokens         += s.outputTokens;
    acc.cachedReadTokens     += s.cachedReadTokens;
    acc.cachedCreationTokens += s.cachedCreationTokens;
    acc.reasoningTokens      += s.reasoningTokens;
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
        cachedCreationTokens: s.cachedCreationTokens,
        reasoningTokens: s.reasoningTokens,
      };
    } else {
      cur.model = s.model; // last-seen
      cur.inputTokens          += s.inputTokens;
      cur.outputTokens         += s.outputTokens;
      cur.cachedReadTokens     += s.cachedReadTokens;
      cur.cachedCreationTokens += s.cachedCreationTokens;
      cur.reasoningTokens      += s.reasoningTokens;
      // honest-null: any contributing null poisons the tier total
      cur.costUSD = (cur.costUSD === null || s.costUSD === null) ? null : cur.costUSD + s.costUSD;
    }
  }
  return out;
}
