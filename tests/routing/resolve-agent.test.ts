import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';

// Mock createProvider so resolveAgent doesn't call the real (un-migrated) one.
// The mock returns a stub Provider whose name matches the slot.
vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: vi.fn((slot: string, config: any) => ({
    name: slot,
    config: config.agents[slot],
    run: vi.fn(),
  })),
}));

import { resolveAgent } from '@zhixuan92/multi-model-agent-core/routing/resolve-agent';

const config: MultiModelConfig = {
  providers: {},  // kept for compat; resolveAgent uses config.agents
  agents: {
    standard: {
      type: 'openai-compatible',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      // deepseek has no web capabilities per profile
    },
    complex: {
      type: 'claude',
      model: 'claude-opus-4-6',
      // claude has web_search + web_fetch per profile
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
};

describe('resolveAgent', () => {
  it('routes to the declared slot when no capabilities required', () => {
    const r = resolveAgent('standard', [], config);
    expect(r.slot).toBe('standard');
    expect(r.capabilityOverride).toBe(false);
  });

  it('routes to declared slot when it has the required capabilities', () => {
    const r = resolveAgent('complex', ['web_search'], config);
    expect(r.slot).toBe('complex');
    expect(r.capabilityOverride).toBe(false);
  });

  it('silently overrides to the other slot on capability mismatch', () => {
    const r = resolveAgent('standard', ['web_search'], config);
    expect(r.slot).toBe('complex');
    expect(r.capabilityOverride).toBe(true);
  });

  it('throws capability_missing when neither slot has the capability', () => {
    const noCapsConfig: MultiModelConfig = {
      providers: {},
      agents: {
        standard: { type: 'openai-compatible', model: 'local', baseUrl: 'http://local/v1' },
        complex: { type: 'openai-compatible', model: 'local2', baseUrl: 'http://local2/v1' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    expect(() => resolveAgent('standard', ['web_search'], noCapsConfig)).toThrow(/capability_missing/);
  });

  it('uses explicit config capabilities over model profile', () => {
    const overrideConfig: MultiModelConfig = {
      providers: {},
      agents: {
        standard: {
          type: 'openai-compatible',
          model: 'deepseek-r1',
          baseUrl: 'https://api.deepseek.com/v1',
          capabilities: ['web_search'],
        },
        complex: { type: 'claude', model: 'claude-opus-4-6' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const r = resolveAgent('standard', ['web_search'], overrideConfig);
    expect(r.slot).toBe('standard');
    expect(r.capabilityOverride).toBe(false);
  });

  it('returns a Provider whose name matches the resolved slot', () => {
    const r = resolveAgent('complex', [], config);
    expect(r.provider).toBeDefined();
    expect(r.provider.name).toBe('complex');
  });
});