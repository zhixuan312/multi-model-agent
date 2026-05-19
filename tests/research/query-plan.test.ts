import { QueryPlanSchema, parseQueryPlan } from '../../packages/core/src/research/query-plan.js';

describe('QueryPlan schema', () => {
  it('accepts a fully populated plan', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: ['stablecoin design'],
      arxivQueries: ['stablecoin'],
      semanticScholarQueries: ['CBDC'],
      githubQueries: [{ q: 'topic:stablecoin', kind: 'repo' }],
      rssFeeds: ['https://hnrss.org/newest?q=stablecoin'],
      directFetches: ['https://www.bis.org/publ/work1356.htm'],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an empty plan (all arrays empty)', () => {
    const ok = QueryPlanSchema.safeParse({
      braveQueries: [], arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], rssFeeds: [], directFetches: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects array length > 8', () => {
    const bad = QueryPlanSchema.safeParse({
      braveQueries: Array(9).fill('q'),
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], rssFeeds: [], directFetches: [],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects query strings > 200 chars', () => {
    const bad = QueryPlanSchema.safeParse({
      braveQueries: ['x'.repeat(201)],
      arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], rssFeeds: [], directFetches: [],
    });
    expect(bad.success).toBe(false);
  });

  it('parseQueryPlan throws with a schema-error message on bad JSON', () => {
    expect(() => parseQueryPlan('{ not json')).toThrow(/JSON|parse/i);
  });

  it('parseQueryPlan returns the parsed object on good JSON', () => {
    const json = JSON.stringify({
      braveQueries: ['q'], arxivQueries: [], semanticScholarQueries: [],
      githubQueries: [], rssFeeds: [], directFetches: [],
    });
    const parsed = parseQueryPlan(json);
    expect(parsed.braveQueries).toEqual(['q']);
  });
});
