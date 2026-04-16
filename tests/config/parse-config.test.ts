import { describe, it, expect } from 'vitest';
import { parseConfig } from '@zhixuan92/multi-model-agent-core/config/schema';

const minimalAgentConfig = {
  type: 'openai-compatible' as const,
  model: 'test-model',
  baseUrl: 'https://test.example.com/v1',
};

describe('parseConfig', () => {
  it('parses valid minimal config with agents', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
    });
    expect(result.agents.standard.model).toBe('test-model');
    expect(result.defaults.timeoutMs).toBe(1_800_000);
    expect(result.defaults.tools).toBe('full');
  });

  it('parses valid full config', () => {
    const input = {
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-6' },
        complex: { type: 'openai-compatible', model: 'gpt-5', baseUrl: 'https://api.example.com' },
      },
      defaults: { timeoutMs: 120_000, tools: 'none' },
    };
    const result = parseConfig(input);
    expect(result.agents.complex.model).toBe('gpt-5');
    expect(result.defaults.tools).toBe('none');
  });

  it('throws on invalid agent type', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'unknown', model: 'x' } as any,
        complex: minimalAgentConfig,
      },
    })).toThrow();
  });

  it('throws on openai-compatible without baseUrl', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'openai-compatible', model: 'x' } as any,
        complex: minimalAgentConfig,
      },
    })).toThrow(/baseUrl/);
  });

  it('throws on invalid effort value', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'claude', model: 'x', effort: 'ultra' } as any,
        complex: minimalAgentConfig,
      },
    })).toThrow();
  });

  it('throws on non-integer timeoutMs', () => {
    expect(() => parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
      defaults: { timeoutMs: 1.5, tools: 'full' },
    })).toThrow();
  });

  it('throws when agents missing', () => {
    expect(() => parseConfig({})).toThrow();
  });

  it('throws when agents.standard missing', () => {
    expect(() => parseConfig({
      agents: {
        complex: minimalAgentConfig,
      } as any,
    })).toThrow();
  });

  it('throws when agents.complex missing', () => {
    expect(() => parseConfig({
      agents: {
        standard: minimalAgentConfig,
      } as any,
    })).toThrow();
  });
});
