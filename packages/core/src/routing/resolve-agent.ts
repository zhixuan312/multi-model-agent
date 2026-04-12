import type { AgentType, AgentCapability, AgentConfig, MultiModelConfig, Provider } from '../types.js';
import { findModelCapabilities } from './model-profiles.js';
import { createProvider } from '../provider.js';

export interface ResolvedAgent {
  slot: AgentType;
  provider: Provider;
  capabilityOverride: boolean;
}

function resolveCapabilities(agent: AgentConfig): AgentCapability[] {
  return agent.capabilities ?? findModelCapabilities(agent.model);
}

function hasAllCapabilities(
  agent: AgentConfig,
  required: AgentCapability[],
): boolean {
  if (required.length === 0) return true;
  const available = resolveCapabilities(agent);
  return required.every((cap) => available.includes(cap));
}

const OTHER_SLOT: Record<AgentType, AgentType> = {
  standard: 'complex',
  complex: 'standard',
};

export function resolveAgent(
  agentType: AgentType,
  requiredCapabilities: AgentCapability[],
  config: MultiModelConfig,
): ResolvedAgent {
  const agents = config.agents ?? { standard: config.providers['standard'] as any, complex: config.providers['complex'] as any };
  const declared = agents[agentType];
  if (hasAllCapabilities(declared, requiredCapabilities)) {
    return {
      slot: agentType,
      provider: createProvider(agentType, config),
      capabilityOverride: false,
    };
  }

  const otherSlot = OTHER_SLOT[agentType];
  const other = agents[otherSlot];
  if (hasAllCapabilities(other, requiredCapabilities)) {
    return {
      slot: otherSlot,
      provider: createProvider(otherSlot, config),
      capabilityOverride: true,
    };
  }

  const missing = requiredCapabilities.filter(
    (cap) =>
      !resolveCapabilities(declared).includes(cap) &&
      !resolveCapabilities(other).includes(cap),
  );
  throw new Error(
    `capability_missing: neither standard nor complex agent has: ${missing.join(', ')}`,
  );
}