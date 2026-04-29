import { describe, it, expect } from 'vitest';
import { normalizeModel } from '../../packages/core/src/telemetry/normalize.js';
import type { ModelFamily } from '../../packages/core/src/routing/model-profiles.js';

describe('normalizeModel', () => {
  it.each([
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'claude-sonnet', 'claude'],
    ['vertex-ai/claude-sonnet-4-6@2024-10-22', 'claude-sonnet', 'claude'],
    ['azure/openai/gpt-5-2025-09-15', 'gpt-5', 'openai'],
    ['openrouter/meta-llama/llama-4-instruct', 'llama-4', 'llama'],
    ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro', 'gemini'],
    ['bedrock.claude-haiku-4-5', 'claude-haiku', 'claude'],
    ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek'],
    ['gpt-5.5', 'gpt-5.5', 'openai'],
    ['MiniMax-M2.7', 'MiniMax-M2', 'minimax'],
    ['grok-4-1-fast', 'grok-4-1-fast', 'grok'],
    ['mistral-large', 'mistral-large', 'mistral'],
    ['qwen3.5-plus', 'qwen', 'qwen'],
    ['command-r-plus', 'command-r', 'cohere'],
    ['phi-4', 'phi', 'phi'],
    ['gemma-3', 'gemma', 'gemma'],
    ['yi-large', 'yi', 'yi'],
    ['kimi-k2', 'kimi', 'kimi'],
    ['sonar-pro', 'sonar', 'sonar'],
    ['nova-pro', 'nova', 'nova'],
    ['glm-5', 'glm-5', 'glm'],
    ['jamba-large', 'jamba', 'jamba'],
    ['granite-3.3', 'granite', 'granite'],
    ['nemotron-4', 'nemotron', 'nemotron'],
    ['dbrx-instruct', 'dbrx', 'dbrx'],
    ['arctic-instruct', 'arctic', 'arctic'],
    ['reka-flash', 'reka', 'reka'],
    ['olmo-2', 'olmo', 'olmo'],
    ['hermes-3', 'hermes', 'hermes'],
    ['wizardlm-2', 'wizardlm', 'wizardlm'],
    ['starcoder2', 'starcoder', 'starcoder'],
    ['dolphin-2.9', 'dolphin', 'dolphin'],
    ['openchat-3.5', 'openchat', 'openchat'],
    ['vicuna-13b', 'vicuna', 'vicuna'],
    ['internlm2.5', 'internlm', 'internlm'],
    ['baichuan2', 'baichuan', 'baichuan'],
    ['ollama/dolphin-mixtral', 'dolphin', 'dolphin'],
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
