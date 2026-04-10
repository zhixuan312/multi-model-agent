import { describe, it, expect } from 'vitest';
import { getProviderEligibility } from '@scope/multi-model-agent-core/routing/get-provider-eligibility';
import type { MultiModelConfig } from '@scope/multi-model-agent-core';

const makeConfig = (overrides: Partial<MultiModelConfig> = {}): MultiModelConfig => ({
  providers: {
    claude: { type: 'claude', model: 'claude-sonnet-4-6' },
    codex: { type: 'codex', model: 'gpt-5-codex' },
    openai: { type: 'openai-compatible', model: 'gpt-5', baseUrl: 'https://api.example.com' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
  ...overrides,
});

describe('getProviderEligibility', () => {
  // ALL PASS — every provider eligible for a trivial task with no required capabilities
  it('returns all eligible when no filters apply', () => {
    const config = makeConfig();
    const result = getProviderEligibility({ prompt: 'x', tier: 'trivial', requiredCapabilities: [] }, config);
    expect(result).toHaveLength(3);
    expect(result.every(r => r.eligible)).toBe(true);
  });

  // CAPABILITY FAILURE
  it('marks claude ineligible when task requires shell capability', () => {
    const config = makeConfig();
    const result = getProviderEligibility({ prompt: 'x', tier: 'trivial', requiredCapabilities: ['shell'] }, config);
    const claude = result.find(r => r.name === 'claude')!;
    expect(claude.eligible).toBe(false);
    expect(claude.reasons.some(r => r.check === 'capability' && r.detail.includes('shell'))).toBe(true);
  });

  it('marks openai ineligible when task requires web_search but tools=none', () => {
    const config = makeConfig();
    const result = getProviderEligibility({ prompt: 'x', tier: 'trivial', requiredCapabilities: ['web_search'], tools: 'none' }, config);
    const openai = result.find(r => r.name === 'openai')!;
    expect(openai.eligible).toBe(false);
    expect(openai.reasons[0].check).toBe('capability');
  });

  // TIER FAILURE
  it('marks claude-sonnet ineligible for reasoning tier task (standard < reasoning)', () => {
    const config = makeConfig();
    const result = getProviderEligibility({ prompt: 'x', tier: 'reasoning', requiredCapabilities: [] }, config);
    // claude-sonnet-4-6 has tier 'standard', reasoning requires 'reasoning' tier
    const claude = result.find(r => r.name === 'claude')!;
    expect(claude.eligible).toBe(false);
    expect(claude.reasons.some(r => r.check === 'tier')).toBe(true);
  });

  // MISSING baseUrl FOR openai-compatible
  it('marks openai ineligible when baseUrl is missing (already caught at parse time but surfaced here too)', () => {
    // This can only happen if config was constructed bypassing schema validation
    const config = makeConfig({
      providers: {
        openai: { type: 'openai-compatible', model: 'gpt-5' } as any,
      },
    });
    const result = getProviderEligibility({ prompt: 'x', tier: 'trivial', requiredCapabilities: [] }, config);
    const openai = result.find(r => r.name === 'openai')!;
    expect(openai.eligible).toBe(false);
    expect(openai.reasons.some(r => r.check === 'missing_required_field')).toBe(true);
  });

  // REASON DETAIL AND MESSAGE SHAPE
  it('reasons include check, detail, and message fields on ineligibility', () => {
    const config = makeConfig();
    const result = getProviderEligibility({ prompt: 'x', tier: 'reasoning', requiredCapabilities: ['shell'] }, config);
    const reason = result[0].reasons[0];
    expect(reason).toHaveProperty('check');
    expect(reason).toHaveProperty('detail');
    expect(reason).toHaveProperty('message');
    expect(typeof reason.message).toBe('string');
  });
});
