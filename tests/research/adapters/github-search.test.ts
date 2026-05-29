import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { saveFetch, restoreFetch, stubFetch, resp } from '../fixtures/mock-fetch.js';
import { githubSearch } from '../../../packages/core/src/research/adapters/github-search.js';

describe('githubSearch', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  it('repo kind maps all fields', async () => {
    const json = readFileSync('tests/research/fixtures/adapters/github-search-repo.json', 'utf8');
    stubFetch(() => resp(200, json));
    const r = await githubSearch('momentum strategy', { kind: 'repo' });
    expect(r).toHaveLength(2);
    expect(r[0].adapterId).toBe('github_search');
    expect(r[0].recordId).toBe('example/momentum-trading');
    expect(r[0].title).toBe('example/momentum-trading');
    expect(r[0].url).toBe('https://github.com/example/momentum-trading');
    expect(r[0].snippet).toBe('A momentum trading strategy implemented in Python with backtesting support');
  });

  it('code kind maps all fields with text-match snippet', async () => {
    const json = readFileSync('tests/research/fixtures/adapters/github-search-code.json', 'utf8');
    stubFetch(() => resp(200, json));
    const r = await githubSearch('momentum strategy', { kind: 'code', pat: 'ghp_test' });
    expect(r).toHaveLength(1);
    expect(r[0].adapterId).toBe('github_search');
    expect(r[0].recordId).toBe('example/algo-trading:src/strategies/momentum.py');
    expect(r[0].title).toBe('example/algo-trading — src/strategies/momentum.py');
    expect(r[0].url).toBe('https://github.com/example/algo-trading/blob/main/src/strategies/momentum.py');
    expect(r[0].snippet).toBe('def momentum_strategy(prices: list[float], lookback: int = 20) -> Signal:');
  });

  it('rate-limit (403 + X-RateLimit-Remaining: 0) returns gracefully', async () => {
    stubFetch(() => resp(403, '{"message":"rate limited"}', { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' }));
    await expect(githubSearch('x', { kind: 'repo' })).rejects.toThrow(/github_rate_limited/);
  });

  it('secondary rate-limit (403 + body message)', async () => {
    stubFetch(() => resp(403, '{"message":"API rate limit exceeded"}', { 'content-type': 'application/json', 'x-ratelimit-remaining': '5' }));
    await expect(githubSearch('x', { kind: 'repo' })).rejects.toThrow(/github_rate_limited/);
  });

  it('redirect rejection', async () => {
    stubFetch(() => resp(301, '', { location: 'https://api.github.com/search/repositories?q=x' }));
    await expect(githubSearch('x', { kind: 'repo' })).rejects.toThrow(/adapter_unexpected_redirect.*github_search/);
  });

  it('non-200 error', async () => {
    stubFetch(() => resp(500, '{}'));
    await expect(githubSearch('x', { kind: 'repo' })).rejects.toThrow(/github_http_500/);
  });

  it('empty results', async () => {
    stubFetch(() => resp(200, '{"total_count":0,"incomplete_results":false,"items":[]}'));
    const r = await githubSearch('xyznonexistent', { kind: 'repo' });
    expect(r).toEqual([]);
  });

  it('maxResults clamping', async () => {
    const manyItems = {
      total_count: 30,
      incomplete_results: false,
      items: Array.from({ length: 30 }, (_, i) => ({
        id: 1000 + i,
        full_name: `org/repo-${i}`,
        html_url: `https://github.com/org/repo-${i}`,
        description: `desc ${i}`,
      })),
    };
    stubFetch((url) => { expect(url).toContain('per_page=25'); return resp(200, JSON.stringify(manyItems)); });
    const upper = await githubSearch('test', { kind: 'repo', maxResults: 100 });
    expect(upper).toHaveLength(25);

    stubFetch((url) => { expect(url).toContain('per_page=1'); return resp(200, JSON.stringify(manyItems)); });
    const lower = await githubSearch('test', { kind: 'repo', maxResults: 0 });
    expect(lower).toHaveLength(1);
  });

  it('malformed items returns empty results', async () => {
    stubFetch(() => resp(200, '{"total_count":1,"incomplete_results":false,"items":{}}'));
    const r = await githubSearch('test', { kind: 'repo' });
    expect(r).toEqual([]);
  });

  it('invalid JSON returns stable adapter error', async () => {
    stubFetch(() => resp(200, '{not json'));
    await expect(githubSearch('test', { kind: 'repo' })).rejects.toThrow(/github_invalid_json/);
  });

  it('invalid kind returns stable adapter error', async () => {
    await expect(githubSearch('test', { kind: 'other' as 'repo' })).rejects.toThrow(/github_invalid_kind/);
  });

  it('code kind requests text-match accept header', async () => {
    stubFetch((_url, init) => {
      expect((init?.headers as Record<string,string>)['accept']).toBe('application/vnd.github.v3.text-match+json');
      return resp(200, '{"items":[]}');
    });
    const r = await githubSearch('momentum strategy', { kind: 'code', pat: 'ghp_test' });
    expect(r).toEqual([]);
  });
});

describe('github-search adapter', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  function interceptCapture(capture: (h: Record<string,string>) => void) {
    stubFetch((_url, init) => {
      capture(init?.headers as Record<string,string>);
      return resp(200, JSON.stringify({ items: [] }));
    });
  }

  it('sends mma-research user-agent header on repo search', async () => {
    let ua = '';
    interceptCapture(h => { ua = h['user-agent']!; });
    await githubSearch('test', { kind: 'repo', maxResults: 1 });
    expect(ua).toMatch(/^mma-research\//);
  });

  it('sends Authorization header when pat provided', async () => {
    let auth = '';
    interceptCapture(h => { auth = h['authorization']!; });
    await githubSearch('test', { kind: 'repo', maxResults: 1, pat: 'ghp_test' });
    expect(auth).toBe('Bearer ghp_test');
  });

  it('omits Authorization when no pat', async () => {
    let auth: string | undefined;
    interceptCapture(h => { auth = h['authorization']; });
    await githubSearch('test', { kind: 'repo', maxResults: 1 });
    expect(auth).toBeUndefined();
  });

  it('rejects kind=code when no pat with pat_required_for_code', async () => {
    await expect(
      githubSearch('test', { kind: 'code', maxResults: 1 })
    ).rejects.toThrow('pat_required_for_code');
  });

  it('allows kind=code when pat provided', async () => {
    let auth = '';
    interceptCapture(h => { auth = h['authorization']!; });
    const out = await githubSearch('test', { kind: 'code', maxResults: 1, pat: 'ghp_test' });
    expect(auth).toBe('Bearer ghp_test');
    expect(out).toEqual([]);
  });
});
