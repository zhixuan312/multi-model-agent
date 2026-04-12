import type { AgentType, AgentCapability, AgentConfig, MultiModelConfig, Provider } from '../types.js';
import { findModelCapabilities } from './model-profiles.js';
import { createProvider } from '../provider.js';

export interface ResolvedAgent {
  slot: AgentType;
  provider: Provider;
  capabilityOverride: boolean;
}

function resolveCapabilities(agent: AgentConfig): AgentCapability[] {
  return agent.capabilities ?? findModelCapabilities(agent.model) ?? [];
}

function hasAllCapabilities(
  agent: AgentConfig,
  required: AgentCapability[],
): boolean {
  if (required.length === 0) return true;
  const available = resolveCapabilities(agent) ?? [];
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
  const agents = config.agents;
  if (!agents) {
    throw new Error('capability_missing: config must have agents defined');
  }
  const declared = agents[agentType];
  if (!declared) {
    throw new Error(`capability_missing: agent "${agentType}" not found in config`);
  }
  if (hasAllCapabilities(declared, requiredCapabilities)) {
    return {
      slot: agentType,
      provider: createProvider(agentType, config),
      capabilityOverride: false,
    };
  }

  const otherSlot = OTHER_SLOT[agentType];
  const other = agents[otherSlot];
  if (other && hasAllCapabilities(other, requiredCapabilities)) {
    return {
      slot: otherSlot,
      provider: createProvider(otherSlot, config),
      capabilityOverride: true,
    };
  }

  const missing = requiredCapabilities.filter(
    (cap) =>
      !resolveCapabilities(declared).includes(cap) &&
      (other ? resolveCapabilities(other).includes(cap) : true),
  );
  throw new Error(
    `capability_missing: neither standard nor complex agent has: ${missing.join(', ')}`,
  );
}