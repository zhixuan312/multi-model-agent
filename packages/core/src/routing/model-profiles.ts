import type { CostTier, ProviderConfig, Tier } from '../types.js';

export interface ModelProfile {
  tier: Tier;
  defaultCost: CostTier;
  bestFor: string;
  avoidFor?: string;
  notes?: string;
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

export function findModelProfile(modelId: string): ModelProfile {
  const normalized = modelId.toLowerCase();
  const keys = Object.keys(MODEL_PROFILES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key.toLowerCase())) {
      return { ...MODEL_PROFILES[key] };
    }
  }
  return { ...DEFAULT_PROFILE };
}

export function getEffectiveCostTier(config: ProviderConfig): CostTier {
  return config.costTier ?? findModelProfile(config.model).defaultCost;
}
