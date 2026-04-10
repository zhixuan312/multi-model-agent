import type { ProviderConfig, TaskSpec, MultiModelConfig } from '../types.js';
import { resolveTaskCapabilities } from './resolve-task-capabilities.js';
import { findModelProfile, getEffectiveCostTier } from './model-profiles.js';

export interface SelectedProvider {
  name: string
  config: ProviderConfig
}

/**
 * Select which provider to use for a task (when provider is omitted).
 * Algorithm:
 * 1. Capability filter (HARD): exclude providers missing any requiredCapability.
 * 2. Tier filter (HARD): exclude providers whose findModelProfile(model).tier < task.tier.
 *    Tier ordering: trivial < standard < reasoning.
 * 3. Cost preference (STRONG): among remainder, select cheapest costTier.
 * 4. Tiebreaker: ASCII/lexicographic by provider name.
 *
 * Returns null if no provider passes all filters.
 */
export function selectProviderForTask(
  task: TaskSpec,
  config: MultiModelConfig,
): SelectedProvider | null {
  const TIER_ORDER: Record<string, number> = { trivial: 0, standard: 1, reasoning: 2 };

  const eligible: { name: string; config: ProviderConfig; costTier: string }[] = [];

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    // 1. Capability check
    const caps = resolveTaskCapabilities(providerConfig, {
      tools: task.tools ?? 'full',
      sandboxPolicy: task.sandboxPolicy ?? providerConfig.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !caps.includes(c));
    if (missing.length > 0) continue;

    // 2. Tier check
    const profile = findModelProfile(providerConfig.model);
    const requiredTierOrder = TIER_ORDER[task.tier] ?? 0;
    const providerTierOrder = TIER_ORDER[profile.tier] ?? 0;
    if (providerTierOrder < requiredTierOrder) continue;

    // Passed both filters — track for cost comparison
    const costTier = getEffectiveCostTier(providerConfig);
    eligible.push({ name, config: providerConfig, costTier });
  }

  if (eligible.length === 0) return null;

  // 3. Sort by cost tier: free < low < medium < high
  const COST_ORDER: Record<string, number> = { free: 0, low: 1, medium: 2, high: 3 };
  eligible.sort((a, b) => {
    const costDiff = (COST_ORDER[a.costTier] ?? 3) - (COST_ORDER[b.costTier] ?? 3);
    if (costDiff !== 0) return costDiff;
    // 4. Tiebreaker: provider name ascending
    return a.name.localeCompare(b.name);
  });

  const winner = eligible[0];
  return { name: winner.name, config: winner.config };
}
