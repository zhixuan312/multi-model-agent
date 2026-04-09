import { describe, it, expect } from 'vitest';
import { getCapabilities } from '../../src/routing/capabilities.js';
import type { ProviderConfig } from '../../src/types.js';

describe('getCapabilities', () => {
  it('returns base capabilities for codex', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = getCapabilities(config);
    expect(caps).toEqual(expect.arrayContaining([
      'file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search',
    ]));
    expect(caps).not.toContain('web_fetch');
  });

  it('returns base capabilities for claude including web_fetch', () => {
    const config: ProviderConfig = { type: 'claude', model: 'claude-opus-4-6' };
    const caps = getCapabilities(config);
    expect(caps).toEqual(expect.arrayContaining([
      'file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch',
    ]));
  });

  it('returns only file tools for openai-compatible without hostedTools', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
    };
    const caps = getCapabilities(config);
    expect(caps).toEqual(
      expect.arrayContaining(['file_read', 'file_write', 'grep', 'glob'])
    );
    expect(caps).not.toContain('shell');
    expect(caps).not.toContain('web_search');
    expect(caps).not.toContain('web_fetch');
  });

  it('merges web_search from hostedTools for openai-compatible', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      hostedTools: ['web_search'],
    };
    const caps = getCapabilities(config);
    expect(caps).toContain('web_search');
  });

  it('ignores image_generation and code_interpreter hostedTools (not in routing vocabulary)', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      hostedTools: ['image_generation', 'code_interpreter'],
    };
    const caps = getCapabilities(config);
    // These aren't in the Capability union, so they shouldn't appear
    expect(caps).not.toContain('image_generation' as never);
    expect(caps).not.toContain('code_interpreter' as never);
  });

  it('deduplicates when hostedTools duplicates a base capability', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
      hostedTools: ['web_search'], // claude already has web_search
    };
    const caps = getCapabilities(config);
    const webSearchCount = caps.filter((c) => c === 'web_search').length;
    expect(webSearchCount).toBe(1);
  });
});
