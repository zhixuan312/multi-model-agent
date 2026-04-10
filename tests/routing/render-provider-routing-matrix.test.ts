import { describe, it, expect } from 'vitest';
import { renderProviderRoutingMatrix } from '@zhixuan92/multi-model-agent-mcp/routing/render-provider-routing-matrix';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

describe('renderProviderRoutingMatrix', () => {
  it('renders single provider with model name, capabilities, tier, cost', () => {
    const config: MultiModelConfig = {
      providers: {
        claude: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('claude (claude-sonnet-4-6)');
    expect(output).toContain('tools:');
    expect(output).toContain('tier:');
    expect(output).toContain('cost:');
  });

  it('renders ROUTING_RECIPE at the end of the matrix', () => {
    const config: MultiModelConfig = {
      providers: { c: { type: 'claude', model: 'claude-sonnet-4-6' } },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('How to route a task:');
    expect(output).toContain('Capability filter');
    expect(output).toContain('Cost preference');
  });

  it('marks cost source as (from config) when costTier is explicitly set', () => {
    const config: MultiModelConfig = {
      providers: {
        cheap: { type: 'openai-compatible', model: 'x', baseUrl: 'https://x.com', costTier: 'free' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('(from config)');
  });

  it('renders multiple providers each with their own block', () => {
    const config: MultiModelConfig = {
      providers: {
        a: { type: 'claude', model: 'claude-sonnet-4-6' },
        b: { type: 'codex', model: 'gpt-5-codex' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('a (claude-sonnet-4-6)');
    expect(output).toContain('b (gpt-5-codex)');
  });

  it('renders bestFor, notes, avoidFor from model profile', () => {
    const config: MultiModelConfig = {
      providers: {
        c: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('best for:');
  });

  it('renders effort support label', () => {
    const config: MultiModelConfig = {
      providers: {
        c: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    };
    const output = renderProviderRoutingMatrix(config);
    expect(output).toContain('effort:');
  });
});
