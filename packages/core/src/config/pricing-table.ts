// packages/core/src/config/pricing-table.ts
// Per-model pricing schema + lookup helpers per architecture.md:62.
//
// Pricing data is embedded in ModelProfile entries (model-profiles.json).
// This module exposes:
//   - the Zod sub-schema for the pricing fields, composed by modelProfileSchema
//   - ModelPricing type
//   - priceFor(modelId) lookup that returns the pricing fields for a given
//     model, or undefined if the model is unknown
//
// `load.ts` carries a separate `Pricing` shape (`inputUSDPerMillion` etc.)
// used by the main-agent pricing resolution path. The two shapes are
// distinct: model-profile pricing is per-million-tokens (`*PerMTok`),
// the main-agent shape uses `*USDPerMillion`. Both record the same
// economic fact at different granularities.
import { z } from 'zod';
import { findModelProfile, type ModelProfile } from './model-profile-registry.js';

export const modelPricingSchema = z.object({
  inputCostPerMTok:          z.number().finite().nonnegative().optional(),
  outputCostPerMTok:         z.number().finite().nonnegative().optional(),
  cachedReadCostPerMTok:     z.number().finite().nonnegative().optional(),
  cachedNonReadCostPerMTok:  z.number().finite().nonnegative().optional(),
  reasoningCostPerMTok:      z.number().finite().nonnegative().optional(),
  rateSource:                z.string().min(1).optional(),
  rateLookupDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

/** Look up per-model pricing. Returns the pricing fields from the matching
 *  ModelProfile, or undefined when the model id matches no profile or the
 *  matched profile lacks pricing data. */
export function priceFor(modelId: string): ModelPricing | undefined {
  const profile: ModelProfile = findModelProfile(modelId);
  const pricing: ModelPricing = {
    inputCostPerMTok: profile.inputCostPerMTok,
    outputCostPerMTok: profile.outputCostPerMTok,
    cachedReadCostPerMTok: profile.cachedReadCostPerMTok,
    cachedNonReadCostPerMTok: profile.cachedNonReadCostPerMTok,
    reasoningCostPerMTok: profile.reasoningCostPerMTok,
    rateSource: profile.rateSource,
    rateLookupDate: profile.rateLookupDate,
  };
  // Only return pricing when at least one rate field is set; otherwise the
  // profile carries no rate-card information and the caller should treat
  // the model as unpriced.
  const hasAnyRate =
    pricing.inputCostPerMTok !== undefined ||
    pricing.outputCostPerMTok !== undefined ||
    pricing.cachedReadCostPerMTok !== undefined ||
    pricing.cachedNonReadCostPerMTok !== undefined ||
    pricing.reasoningCostPerMTok !== undefined;
  return hasAnyRate ? pricing : undefined;
}
