import type { Capability, ProviderConfig, ProviderType } from '../types.js';

const BASE_CAPABILITIES: Record<ProviderType, Capability[]> = {
  'codex': ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search'],
  'claude': ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch'],
  'openai-compatible': ['file_read', 'file_write', 'grep', 'glob'],
};

/**
 * Returns the set of capabilities a provider supports, combining the base
 * set for its type with any routing-relevant entries from hostedTools.
 *
 * Only `web_search` is mapped from hostedTools; `image_generation` and
 * `code_interpreter` are accepted in config but not part of the routing
 * vocabulary in v1 (no current task type requires declaring them).
 */
export function getCapabilities(config: ProviderConfig): Capability[] {
  const base = BASE_CAPABILITIES[config.type];
  const hosted: Capability[] = (config.hostedTools ?? []).includes('web_search')
    ? ['web_search']
    : [];
  return Array.from(new Set([...base, ...hosted]));
}
