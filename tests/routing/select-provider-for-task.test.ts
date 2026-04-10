import { describe, it, expect } from 'vitest';
import { selectProviderForTask } from '@scope/multi-model-agent-core/routing/select-provider-for-task';
import type { MultiModelConfig } from '@scope/multi-model-agent-core';

/**
 * Model tiers from model-profiles.json (prefix → tier, defaultCost):
 *   "claude-opus"  → reasoning, high
 *   "claude-sonnet"→ standard,  medium
 *   "gpt-5"        → reasoning, medium
 *   "MiniMax-M2"   → standard,  low
 *   unknown        → standard,  medium  (DEFAULT_PROFILE)
 *
 * Cost ordering: free < low < medium < high
 * Tier ordering:  trivial < standard < reasoning
 *
 * Capabilities by provider type:
 *   openai-compatible: file_read, file_write, grep, glob  (NO shell, NO web_search by default)
 *   claude:            file_* + grep + glob + web_search + web_fetch  (NO shell unless sandboxPolicy:none)
 *   codex:             file_* + grep + glob + web_search (NO web_fetch, NO shell unless sandboxPolicy:none)
 *
 * Shell capability: only when sandboxPolicy === 'none' on any provider type.
 */

const makeConfig = (providers: MultiModelConfig['providers']): MultiModelConfig => ({
  providers,
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
});

describe('selectProviderForTask', () => {
  // ---------------------------------------------------------------------------
  // 1. returns null when no providers configured
  // ---------------------------------------------------------------------------
  it('returns null when no providers are configured', () => {
    const config = makeConfig({});
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'trivial', requiredCapabilities: [] },
      config,
    );
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. returns null when capability filter removes all providers
  // ---------------------------------------------------------------------------
  it('returns null when capability filter removes all providers', () => {
    // All providers are openai-compatible (no shell by default).
    // Task requires 'shell' → every provider is missing it → all filtered out.
    const config = makeConfig({
      a: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://a.com' },
      b: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://b.com' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'standard', requiredCapabilities: ['shell'] },
      config,
    );
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. returns null when tier filter removes all providers
  // ---------------------------------------------------------------------------
  it('returns null when tier filter removes all providers', () => {
    // All providers use MiniMax-M2-7 → standard tier.
    // Task requires reasoning tier → standard (1) < reasoning (2) → all filtered out.
    const config = makeConfig({
      a: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://a.com' },
      b: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://b.com' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'reasoning', requiredCapabilities: [] },
      config,
    );
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. picks lowest costTier among capable providers
  // ---------------------------------------------------------------------------
  it('picks lowest costTier among capable providers', () => {
    // a: free, b: medium, c: high — all standard-tier (MiniMax-M2-7).
    // a (free) should win.
    const config = makeConfig({
      a: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://a.com', costTier: 'free' },
      b: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://b.com', costTier: 'medium' },
      c: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://c.com', costTier: 'high' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'standard', requiredCapabilities: [] },
      config,
    );
    expect(result?.name).toBe('a');
  });

  // ---------------------------------------------------------------------------
  // 5. uses lexicographic name as tiebreaker when costTiers are equal
  // ---------------------------------------------------------------------------
  it('uses lexicographic name as tiebreaker when costTiers are equal', () => {
    // a, b, c all free → lexicographically 'a' < 'b' < 'c', so 'a' wins.
    const config = makeConfig({
      c: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://c.com', costTier: 'free' },
      a: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://a.com', costTier: 'free' },
      b: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://b.com', costTier: 'free' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'standard', requiredCapabilities: [] },
      config,
    );
    expect(result?.name).toBe('a');
  });

  // ---------------------------------------------------------------------------
  // 6. applies costTier override over profile default
  // ---------------------------------------------------------------------------
  it('applies costTier override over profile default', () => {
    // gpt-5-codex: reasoning tier, profile defaultCost = medium
    //   explicit costTier: 'low' → overrides to 'low'
    // MiniMax-M2-7: standard tier, profile defaultCost = low
    //   explicit costTier: 'medium' → stays 'medium'
    // Task tier=reasoning: gpt-5-codex passes (reasoning), MiniMax-M2-7 fails (standard < reasoning)
    // → only gpt-5-codex is eligible (costTier=low).
    const config = makeConfig({
      a: { type: 'openai-compatible', model: 'gpt-5-codex', baseUrl: 'https://a.com', costTier: 'low' },
      b: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://b.com', costTier: 'medium' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'reasoning', requiredCapabilities: [] },
      config,
    );
    // Only 'a' (gpt-5-codex) passes the reasoning-tier filter.
    // Its effective costTier is 'low' (explicit override from profile default 'medium').
    expect(result?.name).toBe('a');
    expect(result?.config.costTier).toBe('low');
  });

  // ---------------------------------------------------------------------------
  // 7. respects requiredCapabilities filter
  // ---------------------------------------------------------------------------
  it('respects requiredCapabilities filter', () => {
    // gpt-5-codex (reasoning tier, has web_search via codex default) vs
    // MiniMax-M2-7 (standard tier, no web_search).
    // Task requires web_search + tier=reasoning:
    //   - MiniMax-M2-7: fails tier (standard < reasoning) AND fails capability (no web_search)
    //   - gpt-5-codex: passes tier (reasoning) AND passes capability (has web_search) → selected.
    const config = makeConfig({
      ai: { type: 'codex', model: 'gpt-5-codex' },
      cheap: { type: 'openai-compatible', model: 'MiniMax-M2-7', baseUrl: 'https://x.com' },
    });
    const result = selectProviderForTask(
      { prompt: 'search the web', tier: 'reasoning', requiredCapabilities: ['web_search'] },
      config,
    );
    expect(result?.name).toBe('ai');
  });

  // ---------------------------------------------------------------------------
  // 8. respects task.tools='none' to disable file capabilities
  // ---------------------------------------------------------------------------
  it('respects task.tools=none to disable file/tool capabilities', () => {
    // With tools='none', resolveTaskCapabilities() returns [] for the provider.
    // A task that requires file_read therefore fails the capability filter for
    // every provider → null. This proves tools='none' really disables tools.
    const config = makeConfig({
      a: { type: 'openai-compatible', model: 'gpt-5-codex', baseUrl: 'https://a.com' },
      b: { type: 'openai-compatible', model: 'gpt-5-codex', baseUrl: 'https://b.com' },
    });
    const result = selectProviderForTask(
      { prompt: 'x', tier: 'reasoning', requiredCapabilities: ['file_read'], tools: 'none' },
      config,
    );
    expect(result).toBeNull();
  });
});
