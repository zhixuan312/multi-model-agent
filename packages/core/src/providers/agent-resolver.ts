import type { AgentType, MultiModelConfig, Provider } from '../types.js';
import { createProvider } from './provider-factory.js';

export interface ResolvedAgent {
  slot: AgentType;
  provider: Provider;
}

/**
 * Resolve a tier to its provider, labelled with the slot it came from.
 *
 * The unconfigured-tier check belongs to `createProvider` and lives only there. This function
 * used to re-check it first — `agent_not_configured: config has no agents block`, and a second
 * throw for a missing tier — so one condition had two messages and which one a caller read
 * depended on which entry point they used. The factory's is the better of the two: it names
 * the tiers to add. There is no `main` → `complex` substitution on any path; all three tiers
 * are declared config.
 */
export function resolveAgent(
  agentType: AgentType,
  config: MultiModelConfig,
): ResolvedAgent {
  return {
    slot: agentType,
    provider: createProvider(agentType, config),
  };
}
