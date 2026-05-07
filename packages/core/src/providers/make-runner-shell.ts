import type { Provider } from '../types.js';
import { RunnerShell } from './runner-shell.js';
import { buildAdapter } from './provider-factory.js';
import type { RunnerAdapter, AdapterTurnResult } from './runner-adapter.js';

export function makeRunnerShell(provider: Provider): RunnerShell {
  // Test/mock providers expose `__mockAdapter` so the engine path can run
  // without making real HTTP calls. Production providers carry a real config
  // and use `buildAdapter` to produce a real runner adapter.
  const maybeMock = (provider as Provider & { __mockAdapter?: RunnerAdapter }).__mockAdapter;
  if (maybeMock) return new RunnerShell(maybeMock);

  // If the provider looks like a test mock (named 'mock' OR config.model === 'mock'),
  // synthesize a bridge adapter from `provider.run(prompt)` so the engine path
  // works in tests without each test wiring `__mockAdapter` explicitly.
  const cfg = provider.config as { model?: string } | undefined;
  const isMock = provider.name === 'mock' || cfg?.model === 'mock' || cfg?.model === 'mock-model';
  if (isMock && typeof provider.run === 'function') {
    const adapter: RunnerAdapter = {
      providerType: 'mock' as unknown as RunnerAdapter['providerType'],
      async turn(input): Promise<AdapterTurnResult> {
        const prompt = `${input.systemPrompt}\n\n${input.userMessage}`;
        const result = await provider.run(prompt);
        return {
          assistantText: result.output ?? '',
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
            cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
          },
        };
      },
    };
    return new RunnerShell(adapter);
  }

  let adapter: RunnerAdapter | undefined;
  try {
    adapter = buildAdapter(provider.config as {
      type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex';
      model: string;
      baseUrl?: string;
      apiKey?: string;
      apiKeyEnv?: string;
    });
  } catch {
    adapter = undefined;
  }

  // Fallback bridge for any provider whose config doesn't yield a real adapter
  // (typical in tests). Lets every test that has a working `provider.run(prompt)`
  // exercise the engine path without per-test wiring.
  if (!adapter && typeof provider.run === 'function') {
    const bridgeAdapter: RunnerAdapter = {
      providerType: 'mock' as unknown as RunnerAdapter['providerType'],
      async turn(input): Promise<AdapterTurnResult> {
        const prompt = `${input.systemPrompt}\n\n${input.userMessage}`;
        const result = await provider.run(prompt);
        return {
          assistantText: result.output ?? '',
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
            cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
          },
        };
      },
    };
    return new RunnerShell(bridgeAdapter);
  }

  return new RunnerShell(adapter as RunnerAdapter);
}
