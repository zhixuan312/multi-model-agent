import { describe, it, expect } from 'vitest';
import { deriveModelFamily } from '../../packages/core/src/telemetry/event-builder.js';

describe('deriveModelFamily — 12 families', () => {
  it('claude family', () => {
    expect(deriveModelFamily('claude-sonnet-4-5')).toBe('claude');
    expect(deriveModelFamily('claude-haiku-4-5')).toBe('claude');
  });
  it('openai family — gpt, o1, o3, o4, openai prefix', () => {
    expect(deriveModelFamily('gpt-5.5')).toBe('openai');
    expect(deriveModelFamily('o1-mini')).toBe('openai');
    expect(deriveModelFamily('o3')).toBe('openai');
    expect(deriveModelFamily('o4-mini')).toBe('openai');
    expect(deriveModelFamily('openai-experimental')).toBe('openai');
  });
  it('gemini, deepseek, grok, mistral, meta, qwen, zhipu, kimi, minimax', () => {
    expect(deriveModelFamily('gemini-2.5-pro')).toBe('gemini');
    expect(deriveModelFamily('deepseek-v4-pro')).toBe('deepseek');
    expect(deriveModelFamily('grok-4-1-fast')).toBe('grok');
    expect(deriveModelFamily('mistral-large')).toBe('mistral');
    expect(deriveModelFamily('llama2:7b')).toBe('meta');
    expect(deriveModelFamily('meta-llama/Llama-4-Maverick')).toBe('meta');
    expect(deriveModelFamily('qwen-3.5-plus')).toBe('qwen');
    expect(deriveModelFamily('glm-5')).toBe('zhipu');
    expect(deriveModelFamily('kimi-k2')).toBe('kimi');
    expect(deriveModelFamily('MiniMax-M2')).toBe('minimax');
  });
  it('unknown prefixes fall back to other (never reject)', () => {
    expect(deriveModelFamily('some-random-novel-model')).toBe('other');
    expect(deriveModelFamily('completely-made-up-id')).toBe('other');
  });
  it('handles null/empty', () => {
    expect(deriveModelFamily(null)).toBe('other');
    expect(deriveModelFamily(undefined)).toBe('other');
    expect(deriveModelFamily('')).toBe('other');
  });
});
