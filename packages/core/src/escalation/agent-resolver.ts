import type { AgentType, MultiModelConfig, Provider } from '../types.js';
import { createProvider } from '../providers/provider-factory.js';

export interface ResolvedAgent {
  slot: AgentType;
  provider: Provider;
}

export function resolveAgent(
  agentType: AgentType,
  config: MultiModelConfig,
): ResolvedAgent {
  const agents = config.agents;
  if (!agents) {
    throw new Error(`agent_not_configured: config has no agents block`);
  }
  const declared = agents[agentType];
  if (!declared) {
    throw new Error(`agent_not_configured: agent "${agentType}" not found in config`);
  }
  return {
    slot: agentType,
    provider: createProvider(agentType, config),
  };
}
