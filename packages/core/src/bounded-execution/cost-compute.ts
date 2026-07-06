import type { TokenUsage } from '../providers/runner-types.js';

export interface RateCard {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cachedReadCostPerMTok: number;
  cachedNonReadCostPerMTok: number;
}

import { findModelProfile } from '../config/model-profile-registry.js';

export function resolveRateCard(
  model: string | null | undefined,
  override?: Partial<RateCard>,
): RateCard | null {
  if (!model) return null;
  const profile = findModelProfile(model);
  const input = override?.inputCostPerMTok ?? profile.inputCostPerMTok;
  const rawOutput = override?.outputCostPerMTok ?? profile.outputCostPerMTok;
  if (
    input === undefined || rawOutput === undefined ||
    !Number.isFinite(input) || !Number.isFinite(rawOutput) ||
    input < 0 || rawOutput < 0
  ) {
    return null;
  }

  // reasoning tokens are folded into outputTokens by each runner.
  // When a model had a separate (higher) reasoning rate, use that as the
  // output rate to avoid undercounting cost.
  const reasoning = profile.reasoningCostPerMTok;
  const output = (reasoning !== undefined && Number.isFinite(reasoning) && reasoning > rawOutput)
    ? reasoning
    : rawOutput;

  // Cache-read default: 0.1× input — matches Anthropic's 5-min/1-hour
  // cache-read rate and OpenAI's gpt-5.x 90% discount. Explicit per-model
  // overrides in model-profiles.json take precedence.
  const cachedRead = override?.cachedReadCostPerMTok ?? profile.cachedReadCostPerMTok ?? input * 0.10;
  // Cache-write default: 1.0× input. Anthropic charges 1.25× (5-min TTL)
  // or 2.0× (1-hour TTL) for cache writes, but the Anthropic premium is
  // encoded on the `claude` parent profile (`cachedNonRead: 3.75` = 1.25×
  // base $3) and inherited by every claude-* model — so this fallback is
  // only reached for non-Anthropic models that don't emit cache writes
  // (OpenAI/codex doesn't emit a cache-write field) or for unknown
  // providers. For those, "no premium" is the safe default.
  const cachedNonRead = override?.cachedNonReadCostPerMTok ?? profile.cachedNonReadCostPerMTok ?? input;

  return {
    inputCostPerMTok: input,
    outputCostPerMTok: output,
    cachedReadCostPerMTok: cachedRead,
    cachedNonReadCostPerMTok: cachedNonRead,
  };
}

/**
 * Pure pricing — multiplies each token class by its rate. No defaults applied here.
 * Defaults live in resolveRateCard. reasoningTokens are folded into outputTokens
 * by each runner before emission, so there is no separate reasoning term.
 */
export function priceTokens(t: TokenUsage, r: RateCard): number {
  return (
    t.inputTokens          * r.inputCostPerMTok          +
    t.outputTokens         * r.outputCostPerMTok         +
    t.cachedReadTokens     * r.cachedReadCostPerMTok     +
    t.cachedNonReadTokens  * r.cachedNonReadCostPerMTok
  ) / 1_000_000;
}
