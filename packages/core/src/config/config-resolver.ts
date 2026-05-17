import type { MultiModelConfig } from '../types.js';

/**
 * Return the names of agents carrying an inline `apiKey` instead of using
 * `apiKeyEnv`. The schema permits both, but plaintext API keys in a config
 * file are a backup/dotfile/git footgun — serve surfaces this once at
 * startup so the operator can react.
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
