import { describe, it, expect } from 'vitest';
import { describeProviders } from '../../src/routing/describe.js';
import type { MultiModelConfig } from '../../src/types.js';

const makeConfig = (overrides: Partial<MultiModelConfig['providers']> = {}): MultiModelConfig => ({
  providers: {
    codex: { type: 'codex', model: 'gpt-5-codex' },
    claude: { type: 'claude', model: 'claude-opus-4-6' },
    minimax: {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      costTier: 'free',
    },
    ...overrides,
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

describe('describeProviders', () => {
  it('includes every provider name', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('codex');
    expect(out).toContain('claude');
    expect(out).toContain('minimax');
  });

  it('shows the model id for each provider', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('gpt-5-codex');
    expect(out).toContain('claude-opus-4-6');
    expect(out).toContain('MiniMax-M2');
  });

  it('renders the capability list per provider', () => {
    const out = describeProviders(makeConfig());
    // codex has shell + web_search, minimax has only file tools
    expect(out).toMatch(/codex[\s\S]*shell/);
    expect(out).toMatch(/codex[\s\S]*web_search/);
    expect(out).toMatch(/minimax[\s\S]*file_read/);
  });

  it('shows effective cost tier', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('cost: high'); // claude-opus default
    expect(out).toContain('cost: free'); // minimax override
  });

  it('marks cost as "(from config)" when costTier is overridden', () => {
    const out = describeProviders(makeConfig());
    // minimax has costTier: 'free' in config
    expect(out).toMatch(/minimax[\s\S]*cost: free[\s\S]*\(from config\)/);
  });

  it('does not mark cost as "(from config)" when using profile default', () => {
    const out = describeProviders(makeConfig());
    // claude has no costTier override, so cost: high should NOT have "(from config)"
    // Split on blank lines to get individual provider blocks
    const blocks = out.split('\n\n');
    const claudeBlock = blocks.find((b) => b.startsWith('claude (')) ?? '';
    expect(claudeBlock).toContain('cost: high');
    expect(claudeBlock).not.toContain('cost: high (from config)');
    expect(claudeBlock).not.toContain('(from config)');
  });

  it('includes the routing recipe', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('Capability filter');
    expect(out).toContain('Quality filter');
    expect(out).toContain('Cost preference');
    expect(out).toContain('STRONG');
  });

  it('includes tier guidance for the consumer LLM', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('trivial');
    expect(out).toContain('standard');
    expect(out).toContain('reasoning');
  });

  it('stays within a reasonable token budget', () => {
    const out = describeProviders(makeConfig());
    // Rough proxy: ~4 chars/token. Budget: 500 tokens ≈ 2000 chars.
    expect(out.length).toBeLessThan(2000);
  });

  it('renders the tier and bestFor for a known model', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('tier: reasoning'); // claude-opus
    expect(out).toContain('complex, uncertain'); // from claude-opus bestFor
  });

  it('includes avoidFor when present', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('avoid for'); // minimax has avoidFor
  });
});
