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

import { findModelProfile } from '../routing/model-profiles.js';

export function resolveRateCard(
  model: string | null | undefined,
  override?: Partial<RateCard>,
): RateCard | null {
  if (!model) return null;
  const profile = findModelProfile(model);
  const input = profile.inputCostPerMTok;
  const output = profile.outputCostPerMTok;
  if (
    input === undefined || output === undefined ||
    !Number.isFinite(input) || !Number.isFinite(output) ||
    input < 0 || output < 0
  ) {
    return null;
  }

  const cachedRead = profile.cachedReadCostPerMTok ?? input * 0.10;
  const cachedCreation = profile.cachedCreationCostPerMTok ?? input;
  const reasoning = profile.reasoningCostPerMTok ?? output;

  return {
    inputCostPerMTok: input,
    outputCostPerMTok: output,
    cachedReadCostPerMTok: cachedRead,
    cachedCreationCostPerMTok: cachedCreation,
    reasoningCostPerMTok: reasoning,
    ...override,
  };
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
