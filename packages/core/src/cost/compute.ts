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
  const input = override?.inputCostPerMTok ?? profile.inputCostPerMTok;
  const output = override?.outputCostPerMTok ?? profile.outputCostPerMTok;
  if (
    input === undefined || output === undefined ||
    !Number.isFinite(input) || !Number.isFinite(output) ||
    input < 0 || output < 0
  ) {
    return null;
  }

  const cachedRead = override?.cachedReadCostPerMTok ?? profile.cachedReadCostPerMTok ?? input * 0.10;
  const cachedCreation = override?.cachedCreationCostPerMTok ?? profile.cachedCreationCostPerMTok ?? input;
  const reasoning = override?.reasoningCostPerMTok ?? profile.reasoningCostPerMTok ?? output;

  return {
    inputCostPerMTok: input,
    outputCostPerMTok: output,
    cachedReadCostPerMTok: cachedRead,
    cachedCreationCostPerMTok: cachedCreation,
    reasoningCostPerMTok: reasoning,
  };
}

/**
 * Per-field max(0, cur − prev) — for incremental delta-from-cumulative tracking.
 *
 * Two anomaly cases:
 * - Single field decreases: provider reporting glitch. Clamp that field to 0;
 *   warn; carry on. Other fields' deltas remain valid.
 * - All fields decrease (counter reset, e.g., new sub-agent session with fresh
 *   counters): treat `prev` as if it were zero — the entire `cur` becomes the
 *   new delta. Without this branch, lastCumulative would never re-anchor and
 *   every subsequent turn would also produce zero deltas, freezing the meter.
 */
export function subtractTokens(cur: TokenCounts, prev: TokenCounts): TokenCounts {
  const fields: Array<keyof TokenCounts> = [
    'inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedCreationTokens', 'reasoningTokens',
  ];
  const allDecreased = fields.every(f => cur[f] <= prev[f]) && fields.some(f => cur[f] < prev[f]);
  if (allDecreased) {
    // eslint-disable-next-line no-console
    console.warn(`[cost] subtractTokens: detected counter reset (all fields ≤ prev); treating cur as full delta`);
    return { ...cur };
  }
  const out = {} as TokenCounts;
  for (const f of fields) {
    const raw = cur[f] - prev[f];
    if (raw < 0) {
      // eslint-disable-next-line no-console
      console.warn(`[cost] subtractTokens: ${f} went negative (cur=${cur[f]}, prev=${prev[f]}); clamping to 0`);
    }
    out[f] = Math.max(0, raw);
  }
  return out;
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
