import type { CostTier, ProviderConfig, Tier } from '../types.js';

export interface ModelProfile {
  tier: Tier;
  defaultCost: CostTier;
  bestFor: string;
  avoidFor?: string;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-opus': {
    tier: 'reasoning',
    defaultCost: 'high',
    bestFor: 'complex, uncertain, open-ended tasks requiring judgment',
  },
  'claude-sonnet': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'well-scoped code and analysis',
  },
  'gpt-5': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'code implementation + live data lookup',
  },
  'MiniMax-M2': {
    tier: 'standard',
    defaultCost: 'low',
    bestFor: 'well-defined local code tasks with explicit requirements',
    avoidFor: 'ambiguous or research-style tasks',
  },
};

const DEFAULT_PROFILE: ModelProfile = {
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
};

/**
 * Find the quality profile for a model by longest-prefix match against the
 * known family map. Case-insensitive. Falls back to DEFAULT_PROFILE for
 * unmatched models — safe baseline rather than a guess.
 */
export function findProfile(modelId: string): ModelProfile {
  const normalized = modelId.toLowerCase();
  const keys = Object.keys(MODEL_PROFILES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key.toLowerCase())) {
      return MODEL_PROFILES[key];
    }
  }
  return DEFAULT_PROFILE;
}

/**
 * Returns the effective cost tier for a provider: config override if set,
 * otherwise the profile's defaultCost. This is the only profile dimension
 * that is user-configurable, because cost legitimately varies by deployment.
 */
export function effectiveCost(config: ProviderConfig): CostTier {
  return config.costTier ?? findProfile(config.model).defaultCost;
}
