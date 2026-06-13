import { QueryPlanSchema, parseQueryPlan } from '../../packages/core/src/research/query-plan.js';

describe('QueryPlan schema', () => {
  it('accepts a fully populated plan with new adapter queries', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [{ q: 'stablecoin design' }],
      arxivQueries: ['stablecoin'],
      semanticScholarQueries: ['CBDC'],
      githubQueries: [{ q: 'topic:stablecoin', kind: 'repo' }],
      openalexQueries: ['stablecoin mechanism'],
      crossrefQueries: ['CBDC adoption'],
      pubmedQueries: ['CRISPR delivery'],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts brave query with freshness and news endpoint', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [
        { q: 'Apple earnings Q1 2026', freshness: 'pm', endpoint: 'news' },
        { q: 'stablecoin regulation', siteFilter: 'site:sec.gov' },
      ],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.braveQueries[0]!.freshness).toBe('pm');
      expect(ok.data.braveQueries[0]!.endpoint).toBe('news');
      expect(ok.data.braveQueries[1]!.endpoint).toBe('web');
      expect(ok.data.braveQueries[1]!.siteFilter).toBe('site:sec.gov');
    }
  });

  it('accepts brave query with date-range freshness', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [{ q: 'earnings', freshness: '2026-01-01to2026-03-31' }],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects invalid freshness value', () => {
    const bad = QueryPlanSchema.safeParse({
      braveQueries: [{ q: 'q', freshness: 'invalid' }],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(bad.success).toBe(false);
  });

  it('defaults new adapter query lists to empty', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [{ q: 'q' }],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.openalexQueries).toEqual([]);
      expect(ok.data.crossrefQueries).toEqual([]);
      expect(ok.data.pubmedQueries).toEqual([]);
    }
  });

  it('accepts an empty plan (all arrays empty)', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [], arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects array length > 8', () => {
    const bad = QueryPlanSchema.safeParse({
      braveQueries: Array(9).fill({ q: 'q' }),
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects query strings > 200 chars', () => {
    const bad = QueryPlanSchema.safeParse({
      braveQueries: [{ q: 'x'.repeat(201) }],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    expect(bad.success).toBe(false);
  });

  it('parseQueryPlan throws with a schema-error message on bad JSON', () => {
    expect(() => parseQueryPlan('{ not json')).toThrow(/JSON|parse/i);
  });

  it('parseQueryPlan returns the parsed object on good JSON', () => {
    const json = JSON.stringify({
      braveQueries: [{ q: 'q' }], arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
    });
    const parsed = parseQueryPlan(json);
    expect(parsed.braveQueries[0]!.q).toBe('q');
    expect(parsed.braveQueries[0]!.endpoint).toBe('web');
  });
});
