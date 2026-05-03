export interface TokenCounts {
  inputTokens: number;          // non-cached input only
  outputTokens: number;
  cachedReadTokens: number;
  cachedCreationTokens: number;
  reasoningTokens: number;
}

export interface RateCard {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cachedReadCostPerMTok: number;
  cachedCreationCostPerMTok: number;
  reasoningCostPerMTok: number;
}

/**
 * Pure pricing — multiplies each token class by its rate. No defaults applied here.
 * Defaults live in resolveRateCard.
 */
export function priceTokens(t: TokenCounts, r: RateCard): number {
  return (
    t.inputTokens          * r.inputCostPerMTok          +
    t.outputTokens         * r.outputCostPerMTok         +
    t.cachedReadTokens     * r.cachedReadCostPerMTok     +
    t.cachedCreationTokens * r.cachedCreationCostPerMTok +
    t.reasoningTokens      * r.reasoningCostPerMTok
  ) / 1_000_000;
}
