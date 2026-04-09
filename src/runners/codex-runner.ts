import OpenAI from 'openai';
import { getCodexAuth } from '../auth/codex-oauth.js';
import { runOpenAI, type OpenAIRunnerOptions } from './openai-runner.js';
import type { RunResult, RunOptions, ProviderConfig } from '../types.js';

export function createCodexClient(providerConfig: ProviderConfig): OpenAI {
  // Try Codex OAuth first
  const auth = getCodexAuth();
  if (auth) {
    return new OpenAI({
      apiKey: auth.accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: {
        'chatgpt-account-id': auth.accountId,
      },
    });
  }

  // Fall back to OPENAI_API_KEY env var
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAI({ apiKey });
  }

  throw new Error(
    'No Codex credentials found. Run `codex login` or set OPENAI_API_KEY environment variable.',
  );
}

export async function runCodex(
  prompt: string,
  options: RunOptions,
  providerConfig: ProviderConfig,
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' },
): Promise<RunResult> {
  const client = createCodexClient(providerConfig);
  const runnerOptions: OpenAIRunnerOptions = { client, providerConfig, defaults };
  return runOpenAI(prompt, options, runnerOptions);
}
