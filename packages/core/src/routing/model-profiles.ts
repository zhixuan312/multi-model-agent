import { z } from 'zod';
import type { CostTier, ProviderConfig, Tier } from '../types.js';
import profileData from '../model-profiles.json' with { type: 'json' };

const tierSchema = z.enum(['trivial', 'standard', 'reasoning']);
const costTierSchema = z.enum(['free', 'low', 'medium', 'high']);

export const modelProfileSchema = z.object({
  prefix: z.string().min(1),
  tier: tierSchema,
  defaultCost: costTierSchema,
  bestFor: z.string().min(1),
  avoidFor: z.string().optional(),
  notes: z.string().optional(),
  supportsEffort: z.boolean(),
  inputCostPerMTok: z.number().finite().nonnegative().optional(),
  outputCostPerMTok: z.number().finite().nonnegative().optional(),
  rateSource: z.string().min(1).optional(),
  rateLookupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Per-model-family default for the watchdog input-token soft limit.
   *  See spec A.1.4. */
  inputTokenSoftLimit: z.number().int().positive(),
  capabilities: z.array(z.enum(['web_search', 'web_fetch'])).default([]),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

const DEFAULT_PROFILE: ModelProfile = {
  prefix: '',
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
  supportsEffort: false,
  inputTokenSoftLimit: 100_000,
};

// Validate and sort once at module load — longest prefix wins
const PROFILE_ENTRIES: ModelProfile[] = (() => {
  const parsed = z.array(modelProfileSchema).safeParse(profileData);
  if (!parsed.success) {
    throw new Error(`model-profiles.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data.sort((a, b) => b.prefix.length - a.prefix.length);
})();

export function findModelProfile(modelId: string): ModelProfile {
  const normalized = modelId.toLowerCase();
  for (const entry of PROFILE_ENTRIES) {
    if (normalized.startsWith(entry.prefix.toLowerCase())) {
      return { ...entry };
    }
  }
  return { ...DEFAULT_PROFILE };
}

export function findModelCapabilities(modelId: string): ('web_search' | 'web_fetch')[] {
  return findModelProfile(modelId).capabilities ?? [];
}

export function getEffectiveCostTier(config: ProviderConfig): CostTier {
  return config.costTier ?? findModelProfile(config.model).defaultCost;
}
