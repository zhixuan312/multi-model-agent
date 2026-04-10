import type {
  EligibilityFailure,
  MultiModelConfig,
  ProviderConfig,
  ProviderEligibility,
  TaskSpec,
  Tier,
} from '../types.js';
import { resolveTaskCapabilities } from './resolve-task-capabilities.js';
import { findModelProfile, getEffectiveCostTier } from './model-profiles.js';

const TIER_ORDER: Record<Tier, number> = { trivial: 0, standard: 1, reasoning: 2 };

/**
 * Returns structured eligibility report for every configured provider.
 * Each entry states whether the provider is eligible and, if not, which
 * specific checks failed and why.
 */
export function getProviderEligibility(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderEligibility[] {
  return Object.entries(config.providers).map(([name, providerConfig]): ProviderEligibility => {
    const reasons: EligibilityFailure[] = [];

    // Capability check
    const caps = resolveTaskCapabilities(providerConfig, {
      tools: task.tools ?? 'full',
      sandboxPolicy: task.sandboxPolicy ?? providerConfig.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !caps.includes(c));
    if (missing.length > 0) {
      reasons.push({
        check: 'capability',
        detail: `missing: ${missing.join(', ')}`,
        message: `Provider "${name}" cannot satisfy requiredCapabilities: ${missing.join(', ')}.`,
      });
    }

    // Tier check
    const profile = findModelProfile(providerConfig.model);
    const requiredTierOrder = TIER_ORDER[task.tier];
    const providerTierOrder = TIER_ORDER[profile.tier];
    if (providerTierOrder < requiredTierOrder) {
      reasons.push({
        check: 'tier',
        detail: `provider tier: ${profile.tier}, required: ${task.tier}`,
        message: `Provider "${name}" (${profile.tier}) is below required tier ${task.tier}.`,
      });
    }

    // OpenAI-compatible requires baseUrl (but this is caught by schema at parse time,
    // so we surface it here as a sanity check)
    if (providerConfig.type === 'openai-compatible' && !providerConfig.baseUrl) {
      reasons.push({
        check: 'missing_required_field',
        detail: 'baseUrl is missing',
        message: `Provider "${name}" (openai-compatible) is missing required field: baseUrl.`,
      });
    }

    return {
      name,
      config: providerConfig,
      eligible: reasons.length === 0,
      reasons,
    };
  });
}
