import type { Provider } from '../types.js';
import { RunnerShell } from './runner-shell.js';
import { buildAdapter } from './provider-factory.js';
import type { RunnerAdapter } from './runner-adapter.js';

export function makeRunnerShell(provider: Provider): RunnerShell {
  const adapter: RunnerAdapter = buildAdapter(provider.config as {
    type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex';
    model: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
  });
  return new RunnerShell(adapter);
}
