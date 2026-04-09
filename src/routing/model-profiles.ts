import type { CostTier, ProviderConfig, Tier } from '../types.js';

export interface ModelProfile {
  tier: Tier;
  defaultCost: CostTier;
  bestFor: string;
  avoidFor?: string;
  /**
   * Optional clarifying note rendered below bestFor. Use sparingly — only
   * when the bestFor line alone would mislead the consumer LLM about what
   * the model can actually do on its own (e.g., clarifying that a model's
   * tool-using strength depends on tools actually being enabled).
   */
  notes?: string;
  /**
   * Whether the model honors the `effort` knob. When false, the runner
   * silently ignores any effort value — the consumer LLM should not bother
   * setting it for this provider.
   */
  supportsEffort: boolean;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-opus': {
    tier: 'reasoning',
    defaultCost: 'high',
    bestFor: 'frontier coding, complex judgment, long-horizon agent tasks, high-stakes professional work',
    supportsEffort: true,
  },
  'claude-sonnet': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'strong code generation, analysis, agent workflows, and general professional tasks',
    supportsEffort: true,
  },
  'gpt-5': {
    tier: 'reasoning',
    defaultCost: 'medium',
    bestFor: 'coding, agentic workflows, and tool-using tasks',
    notes: 'live data lookup requires web/tool support, not model alone',
    supportsEffort: true,
  },
  'MiniMax-M2': {
    tier: 'standard',
    defaultCost: 'low',
    bestFor: 'cost-efficient coding and agent workflows with clear requirements',
    avoidFor: 'highest-stakes ambiguous work when you need top-tier judgment',
    supportsEffort: true,
  },
};

const DEFAULT_PROFILE: ModelProfile = {
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
  supportsEffort: false,
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
      return { ...MODEL_PROFILES[key] };
    }
  }
  return { ...DEFAULT_PROFILE };
}

/**
 * Returns the effective cost tier for a provider: config override if set,
 * otherwise the profile's defaultCost. This is the only profile dimension
 * that is user-configurable, because cost legitimately varies by deployment.
 */
export function effectiveCost(config: ProviderConfig): CostTier {
  return config.costTier ?? findProfile(config.model).defaultCost;
}
