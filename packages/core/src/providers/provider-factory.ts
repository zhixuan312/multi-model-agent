// v4.4 provider-factory. Two runtimes, two factories: claude (in-process
// via claude-agent-sdk) and codex (subprocess via codex CLI). The Provider
// exposes only `openSession`; legacy `run`/`runReview` are gone.

import type {
  AgentType, Provider, MultiModelConfig,
} from '../types.js';
import type { ClaudeProviderConfig, CodexProviderConfig } from '../types/config.js';
import { makeClaudeProvider } from './claude.js';
import { makeCodexProvider } from './codex.js';

let coreTestProviderOverride: Provider | null = null;
let coreTestProviderOverrideMap: Map<AgentType, Provider> | null = null;

function assertTestProviderEnabled(): void {
  if (process.env.MMAGENT_TEST_PROVIDER_OVERRIDE !== '1') {
    throw new Error('MMAGENT_TEST_PROVIDER_OVERRIDE must be set to 1 to use the test provider override');
  }
}

export function __setCoreTestProviderOverride(provider: Provider | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverride = provider;
}

export function __setCoreTestProviderOverrideMap(map: Map<AgentType, Provider> | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverrideMap = map;
}

export function createProvider(slot: AgentType, config: MultiModelConfig): Provider {
  if (coreTestProviderOverrideMap?.has(slot)) return coreTestProviderOverrideMap.get(slot)!;
  if (coreTestProviderOverride) return coreTestProviderOverride;

  const agentConfig = config.agents[slot];
  if (!agentConfig) {
    throw new Error(`Unknown agent slot: "${slot}". Config must have "standard" and "complex".`);
  }

  const apiKey = (agentConfig as { apiKey?: string }).apiKey
    ?? ((agentConfig as { apiKeyEnv?: string }).apiKeyEnv
        ? process.env[(agentConfig as { apiKeyEnv: string }).apiKeyEnv]
        : undefined);

  const baseUrl = (agentConfig as { baseUrl?: string }).baseUrl;
  const apiKeyEnv = (agentConfig as { apiKeyEnv?: string }).apiKeyEnv;

  let provider: Provider;
  switch (agentConfig.type) {
    case 'claude':
      provider = makeClaudeProvider({
        type: 'claude',
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...(apiKeyEnv && { apiKeyEnv }),
        ...(baseUrl && { baseUrl }),
      } as ClaudeProviderConfig);
      break;
    case 'codex':
      provider = makeCodexProvider({
        type: 'codex',
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...(apiKeyEnv && { apiKeyEnv }),
        ...(baseUrl && { baseUrl }),
      } as CodexProviderConfig);
      break;
    default:
      throw new Error(`Unknown agent type for slot "${slot}": ${(agentConfig as { type: string }).type}`);
  }

  // Preserve the legacy convention: `name = slot` (not `<provider>:<model>`)
  // so existing call sites (e.g., `p.name === 'standard'`) keep working.
  return { ...provider, name: slot };
}
