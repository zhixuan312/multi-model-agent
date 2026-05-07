import { describe, it, expect } from 'vitest';
import { normalizeModel } from '../../packages/core/src/events/normalize.js';
import type { ModelFamily } from '../../packages/core/src/config/model-profile-registry.js';

describe('normalizeModel', () => {
  // 4.0.3+: canonical preserves model+version (e.g. claude-sonnet-4-6,
  // not the prefix claude-sonnet). Date suffixes, provisioning -v1
  // markers, and wrapper-boundary tokens (`:`, `_`, `@`) are stripped.
  it.each([
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'claude-sonnet-4-6', 'claude'],
    ['vertex-ai/claude-sonnet-4-6@2024-10-22', 'claude-sonnet-4-6', 'claude'],
    ['azure/openai/gpt-5-2025-09-15', 'gpt-5', 'openai'],
    ['openrouter/meta-llama/llama-4-instruct', 'llama-4-instruct', 'llama'],
    ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-05-06', 'gemini'],
    ['bedrock.claude-haiku-4-5', 'claude-haiku-4-5', 'claude'],
    ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek'],
    ['gpt-5.5', 'gpt-5.5', 'openai'],
    ['MiniMax-M2.7', 'MiniMax-M2.7', 'minimax'],
    ['grok-4-1-fast', 'grok-4-1-fast', 'grok'],
    ['mistral-large', 'mistral-large', 'mistral'],
    ['qwen3.5-plus', 'qwen3.5-plus', 'qwen'],
    ['command-r-plus', 'command-r-plus', 'cohere'],
    ['phi-4', 'phi-4', 'phi'],
    ['gemma-3', 'gemma-3', 'gemma'],
    ['yi-large', 'yi-large', 'yi'],
    ['kimi-k2', 'kimi-k2', 'kimi'],
    ['sonar-pro', 'sonar-pro', 'sonar'],
    ['nova-pro', 'nova-pro', 'nova'],
    ['glm-5', 'glm-5', 'glm'],
    ['jamba-large', 'jamba-large', 'jamba'],
    ['granite-3.3', 'granite-3.3', 'granite'],
    ['nemotron-4', 'nemotron-4', 'nemotron'],
    ['dbrx-instruct', 'dbrx-instruct', 'dbrx'],
    ['arctic-instruct', 'arctic-instruct', 'arctic'],
    ['reka-flash', 'reka-flash', 'reka'],
    ['olmo-2', 'olmo-2', 'olmo'],
    ['hermes-3', 'hermes-3', 'hermes'],
    ['wizardlm-2', 'wizardlm-2', 'wizardlm'],
    ['starcoder2', 'starcoder2', 'starcoder'],
    ['dolphin-2.9', 'dolphin-2.9', 'dolphin'],
    ['openchat-3.5', 'openchat-3.5', 'openchat'],
    ['vicuna-13b', 'vicuna-13b', 'vicuna'],
    ['internlm2.5', 'internlm2.5', 'internlm'],
    ['baichuan2', 'baichuan2', 'baichuan'],
    ['ollama/dolphin-mixtral', 'dolphin-mixtral', 'dolphin'],
    ['unknown-fake-model-xyz', 'custom', 'other'],
  ])('normalizes %s → canonical=%s family=%s', (input, canonical, family) => {
    const result = normalizeModel(input);
    expect(result.canonical).toBe(canonical);
    expect(result.family).toBe(family as ModelFamily);
  });

  it('rejects empty string', () => {
    const result = normalizeModel('');
    expect(result.canonical).toBe('custom');
    expect(result.family).toBe('other');
  });

  it('is idempotent for vendor-prefixed inputs', () => {
    const ids = [
      'bedrock.claude-haiku-4-5',
      'vertex_ai/anthropic.claude-sonnet-4-5-v1:0',
      'azure/gpt-5.5',
      'openrouter/meta-llama/llama-4-instruct',
      'anthropic.claude-opus-4-7',
    ];
    for (const id of ids) {
      const once = normalizeModel(id);
      const twice = normalizeModel(once.canonical);
      expect(twice.canonical).toBe(once.canonical);
      expect(twice.family).toBe(once.family);
    }
  });

  it('is idempotent for bare model names', () => {
    const ids = ['gpt-5.5', 'deepseek-v4-pro', 'claude-sonnet-4-6', 'MiniMax-M2.7'];
    for (const id of ids) {
      const once = normalizeModel(id);
      const twice = normalizeModel(once.canonical);
      expect(twice.canonical).toBe(once.canonical);
      expect(twice.family).toBe(once.family);
    }
  });
});
