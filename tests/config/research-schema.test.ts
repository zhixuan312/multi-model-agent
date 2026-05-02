import { describe, expect, it } from 'vitest';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

describe('ResearchConfigSchema', () => {
  it('applies defaults when given empty input', () => {
    const r = ResearchConfigSchema.parse({});
    expect(r.brave.apiKeys).toEqual([]);
    expect(r.brave.timeoutMs).toBe(8000);
    expect(r.fetch.maxRedirects).toBe(3);
    expect(r.fetch.maxBodyBytes).toBe(1024 * 1024);
    expect(r.fetch.allowPrivateNetwork).toBe(false);
    expect(r.builtinAdapters.arxiv).toBe(true);
    expect(r.userSources).toEqual([]);
    expect(r.fetchAllowlistExtra).toEqual([]);
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

  it('IDNA-normalizes fetchAllowlistExtra hosts', () => {
    const r = ResearchConfigSchema.parse({
      fetchAllowlistExtra: ['EXAMPLE.com', 'examplé.com'],
    });
    expect(r.fetchAllowlistExtra).toContain('example.com');
    expect(r.fetchAllowlistExtra).toContain('xn--exampl-gva.com');
  });

  it('rejects fetchAllowlistExtra entries with scheme/path/port', () => {
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['https://example.com'] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['example.com:8080'] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['example.com/path'] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['user@example.com'] })).toThrow();
  });

  it('rejects IP literals in fetchAllowlistExtra', () => {
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['127.0.0.1'] })).toThrow();
    expect(() => ResearchConfigSchema.parse({ fetchAllowlistExtra: ['[::1]'] })).toThrow();
  });

  it('rejects unknown keys (.strict)', () => {
    expect(() => ResearchConfigSchema.parse({ unknownKey: true })).toThrow();
    expect(() => ResearchConfigSchema.parse({ brave: { unknown: 1 } })).toThrow();
  });

  it('cross-field check: totalDeadlineMs >= connectTimeoutMs', () => {
    expect(() => ResearchConfigSchema.parse({
      fetch: { connectTimeoutMs: 9000, totalDeadlineMs: 5000 },
    })).toThrow(/fetch_invalid_deadlines/);
  });

  it('caps maxBodyBytes at 4 MiB', () => {
    expect(() => ResearchConfigSchema.parse({ fetch: { maxBodyBytes: 5 * 1024 * 1024 } })).toThrow();
  });

  it('caps userSources at 50 entries', () => {
    const big = Array.from({ length: 51 }, (_, i) => `entry ${i}`);
    expect(() => ResearchConfigSchema.parse({ userSources: big })).toThrow();
  });
});
