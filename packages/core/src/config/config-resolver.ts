// packages/core/src/config/config-resolver.ts
// Layered-defaults resolution per architecture.md:58.
// Extracted from load.ts; file-IO stays there, the resolution helpers
// (decide-which-source-wins) live here.
import { pricingSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

export type Pricing = {
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
  cachedReadUSDPerMillion: number;
  cachedNonReadUSDPerMillion: number;
};

export type MainAgentModelResolution =
  | { kind: 'shipped'; model: string; pricing: Pricing }
  | { kind: 'shipped_overrides_user'; model: string; pricing: Pricing; warning: string }
  | { kind: 'user_for_unknown'; model: string; pricing: Pricing }
  | { kind: 'fail'; reason: string };

/**
 * Return the names of agents carrying an inline `apiKey` instead of using
 * `apiKeyEnv`. The schema permits both, but plaintext API keys in a config
 * file are a backup/dotfile/git footgun — serve surfaces this once at
 * startup so the operator can react. Applies to any agent (claude/codex)
 * that has been configured against a non-default backend (`baseUrl` set)
 * and chosen to inline the key.
 */
export function collectInlineApiKeyOffenders(config: MultiModelConfig): string[] {
  const offenders: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (typeof (agent as { apiKey?: unknown }).apiKey === 'string') {
      offenders.push(name);
    }
  }
  return offenders;
}

/**
 * Resolve pricing for the main agent model.
 *
 * Four cases per spec contract:
 * 1. Known model + no user pricing → shipped pricing.
 * 2. Known model + user pricing → shipped pricing WINS; caller should emit a one-time boot warning.
 * 3. Unknown model + user pricing → user pricing as the delta-calculation baseline.
 * 4. Unknown model + no user pricing → fail-loud at boot.
 */
export function resolveMainAgentModel(
  modelId: string,
  userPricing: Pricing | undefined,
  shippedPricing: Map<string, Pricing>,
): MainAgentModelResolution {
  const known = shippedPricing.get(modelId);
  if (known && !userPricing) return { kind: 'shipped', model: modelId, pricing: known };
  if (known && userPricing) {
    return {
      kind: 'shipped_overrides_user',
      model: modelId,
      pricing: known,
      warning: `user supplied pricing for known model '${modelId}'; ignoring user value in favor of shipped pricing`,
    };
  }
  if (!known && userPricing) return { kind: 'user_for_unknown', model: modelId, pricing: userPricing };
  return {
    kind: 'fail',
    reason: `mainAgentModel '${modelId}' is unknown to shipped pricing; supply 'mainAgentPricing' in config or use a shipped model id.`,
  };
}

/**
 * Parse a user-supplied pricing object through the pricing schema.
 * Returns the validated Pricing or a ZodError.
 */
export function validateUserPricing(raw: unknown): Pricing {
  return pricingSchema.parse(raw) as Pricing;
}
