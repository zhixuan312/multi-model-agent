import { describe, it, expect } from 'vitest';
import { createProvider } from '@zhixuan92/multi-model-agent-core';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const baseConfig: MultiModelConfig = {
  providers: {
    deepseek: {
      type: 'openai-compatible',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    codex: {
      type: 'codex',
      model: 'gpt-5.4',
    },
    claude: {
      type: 'claude',
      model: 'claude-sonnet-4-6',
    },
  },
  defaults: {
    maxTurns: 200,
    timeoutMs: 600000,
    tools: 'full',
  },
};

describe('createProvider', () => {
  it('creates an openai-compatible provider', () => {
    const provider = createProvider('deepseek', baseConfig);
    expect(provider.name).toBe('deepseek');
    expect(provider.config.type).toBe('openai-compatible');
    expect(provider.config.model).toBe('deepseek-r1');
  });

  it('creates a codex provider', () => {
    const provider = createProvider('codex', baseConfig);
    expect(provider.name).toBe('codex');
    expect(provider.config.type).toBe('codex');
  });

  it('creates a claude provider', () => {
    const provider = createProvider('claude', baseConfig);
    expect(provider.name).toBe('claude');
    expect(provider.config.type).toBe('claude');
  });

  it('throws for unknown provider', () => {
    expect(() => createProvider('unknown', baseConfig)).toThrow(
      /Provider "unknown" not found/,
    );
  });

  it('lists available providers in error message', () => {
    expect(() => createProvider('unknown', baseConfig)).toThrow(
      /Available: claude, codex, deepseek/,
    );
  });

  it('provider has run method', () => {
    const provider = createProvider('deepseek', baseConfig);
    expect(typeof provider.run).toBe('function');
  });
});