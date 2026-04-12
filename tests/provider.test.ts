import { describe, it, expect } from 'vitest';
import { createProvider } from '@zhixuan92/multi-model-agent-core/provider';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const config: MultiModelConfig = {
  agents: {
    standard: {
      type: 'openai-compatible',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    complex: {
      type: 'claude',
      model: 'claude-opus-4-6',
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
};

describe('createProvider (1.0.0)', () => {
  it('creates a provider from the standard slot', () => {
    const p = createProvider('standard', config);
    expect(p.name).toBe('standard');
    expect(p.config.type).toBe('openai-compatible');
    expect(p.config.model).toBe('deepseek-r1');
  });

  it('creates a provider from the complex slot', () => {
    const p = createProvider('complex', config);
    expect(p.name).toBe('complex');
    expect(p.config.type).toBe('claude');
  });

  it('throws on invalid slot name', () => {
    expect(() => createProvider('nonexistent' as any, config)).toThrow();
  });
});
