import { describe, it, expect } from 'vitest';
import { parseConfig } from '@scope/multi-model-agent-core/config/schema';

describe('parseConfig', () => {
  it('parses valid minimal config and applies all defaults', () => {
    const result = parseConfig({});
    expect(result.providers).toEqual({});
    expect(result.defaults.maxTurns).toBe(200);
    expect(result.defaults.timeoutMs).toBe(600_000);
    expect(result.defaults.tools).toBe('full');
  });

  it('parses valid full config', () => {
    const input = {
      providers: {
        c: { type: 'claude', model: 'claude-sonnet-4-6', effort: 'high' },
      },
      defaults: { maxTurns: 50, timeoutMs: 120_000, tools: 'none' },
    };
    const result = parseConfig(input);
    expect(result.providers.c.model).toBe('claude-sonnet-4-6');
    expect(result.defaults.maxTurns).toBe(50);
    expect(result.defaults.tools).toBe('none');
  });

  it('throws on invalid provider type', () => {
    expect(() => parseConfig({
      providers: { bad: { type: 'unknown', model: 'x' } },
    })).toThrow();
  });

  it('throws on negative maxTurns in defaults', () => {
    expect(() => parseConfig({
      defaults: { maxTurns: -1, timeoutMs: 600_000, tools: 'full' },
    })).toThrow();
  });

  it('throws on openai-compatible without baseUrl', () => {
    expect(() => parseConfig({
      providers: { bad: { type: 'openai-compatible', model: 'x' } },
    })).toThrow(/baseUrl/);
  });

  it('throws on invalid effort value', () => {
    expect(() => parseConfig({
      providers: { c: { type: 'claude', model: 'x', effort: 'ultra' } },
    })).toThrow();
  });

  it('throws on invalid costTier value', () => {
    expect(() => parseConfig({
      providers: { c: { type: 'claude', model: 'x', costTier: 'expensive' } },
    })).toThrow();
  });

  it('throws on non-integer timeoutMs', () => {
    expect(() => parseConfig({
      defaults: { maxTurns: 200, timeoutMs: 1.5, tools: 'full' },
    })).toThrow();
  });

  it('throws on zero maxTurns', () => {
    expect(() => parseConfig({
      defaults: { maxTurns: 0, timeoutMs: 600_000, tools: 'full' },
    })).toThrow();
  });

  it('applies provider-level overrides on top of defaults', () => {
    const result = parseConfig({
      providers: {
        c: { type: 'claude', model: 'claude-sonnet-4-6', maxTurns: 10 },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });
    expect(result.providers['c'].maxTurns).toBe(10);
  });
});
