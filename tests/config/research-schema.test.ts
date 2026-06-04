import { describe, expect, it } from 'vitest';
import { ResearchConfigSchema, multiModelConfigSchema } from '../../packages/core/src/config/schema.js';

describe('ResearchConfigSchema', () => {
  it('applies defaults when given empty input', () => {
    const r = ResearchConfigSchema.parse({});
    expect(r.brave.apiKeys).toEqual([]);
    expect(r.brave.timeoutMs).toBe(8000);
    expect(r.brave.minPerKeyIntervalMs).toBe(1100);
    expect(r.builtinAdapters.arxiv).toBe(true);
    expect(r.builtinAdapters.semanticScholar).toBe(true);
    expect(r.builtinAdapters.githubSearch).toBe(true);
  });

  it('trims and dedupes apiKeys', () => {
    const r = ResearchConfigSchema.parse({
      brave: { apiKeys: ['  k1  ', 'k2', 'k1', '  k2'] },
    });
    expect(r.brave.apiKeys).toEqual(['k1', 'k2']);
  });

  it('rejects whitespace-only apiKeys', () => {
    expect(() => ResearchConfigSchema.parse({ brave: { apiKeys: ['   '] } })).toThrow();
  });

  it('accepts minPerKeyIntervalMs=0 and rejects out-of-range', () => {
    expect(ResearchConfigSchema.parse({ brave: { minPerKeyIntervalMs: 0 } }).brave.minPerKeyIntervalMs).toBe(0);
    expect(() => ResearchConfigSchema.parse({ brave: { minPerKeyIntervalMs: 20_000 } })).toThrow();
  });

  it('rejects unknown keys (.strict)', () => {
    expect(() => ResearchConfigSchema.parse({ unknownKey: true })).toThrow();
    expect(() => ResearchConfigSchema.parse({ brave: { unknown: 1 } })).toThrow();
    // rss / web_fetch removed: their former config keys are now unknown.
    expect(() => ResearchConfigSchema.parse({ fetch: {} })).toThrow();
    expect(() => ResearchConfigSchema.parse({ userSources: [] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: [] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ builtinAdapters: { genericRss: true } })).toThrow();
  });
});

describe('ResearchConfigSchema inside multiModelConfigSchema', () => {
  const minimalAgents = {
    standard: { type: 'codex' as const, model: 'test', baseUrl: 'https://example.com' },
    complex: { type: 'codex' as const, model: 'test', baseUrl: 'https://example.com' },
  };

  it('defaults research when omitted from full config', () => {
    const c = multiModelConfigSchema.parse({ agents: minimalAgents });
    expect(c.research.brave.apiKeys).toEqual([]);
    expect(c.research.brave.timeoutMs).toBe(8000);
    expect(c.research.builtinAdapters.arxiv).toBe(true);
  });

  it('accepts partial research override', () => {
    const c = multiModelConfigSchema.parse({
      agents: minimalAgents,
      research: { brave: { apiKeys: ['my-key'] } },
    });
    expect(c.research.brave.apiKeys).toEqual(['my-key']);
    expect(c.research.brave.timeoutMs).toBe(8000); // default still applies
  });

  it('rejects invalid research sub-field', () => {
    expect(() => multiModelConfigSchema.parse({
      agents: minimalAgents,
      research: { brave: { timeoutMs: 999_999 } },
    })).toThrow();
  });
});
