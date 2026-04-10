import type { Capability, ProviderConfig, RunOptions } from '../../types.js';
import { getBaseCapabilities } from './capabilities.js';

/**
 * Returns the capabilities a task will have at runtime, accounting for
 * tools, sandboxPolicy, and hosted tools overrides.
 */
export function resolveTaskCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[] {
  // If tools are disabled for this task, no capabilities are offered.
  if (options.tools === 'none') return [];

  // Merge the per-task sandboxPolicy override (if any) into a config snapshot
  // before asking getBaseCapabilities. The provider's persisted config is NOT
  // mutated.
  const mergedConfig: ProviderConfig = {
    ...providerConfig,
    sandboxPolicy: options.sandboxPolicy ?? providerConfig.sandboxPolicy,
  };

  return getBaseCapabilities(mergedConfig);
}
