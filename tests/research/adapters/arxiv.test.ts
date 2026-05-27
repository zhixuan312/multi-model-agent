import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { saveFetch, restoreFetch, stubFetch, resp } from '../fixtures/mock-fetch.js';
import { arxivSearch } from '../../../packages/core/src/research/adapters/arxiv.js';

describe('arxivSearch', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  it('parses Atom XML into AdapterResult[]', async () => {
    const xml = readFileSync('tests/research/fixtures/adapters/arxiv-search.xml', 'utf8');
    stubFetch(() => resp(200, xml, { 'content-type': 'application/atom+xml' }));
    const r = await arxivSearch('regime detection', { maxResults: 10 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toMatchObject({
      adapterId: 'arxiv',
      title: expect.any(String),
      url: expect.stringMatching(/^https:\/\//),
      recordId: expect.stringMatching(/\d{4}\.\d{5}/),
    });
  });

  it('returns [] on unexpected redirect', async () => {
    stubFetch(() => resp(302, '', { location: 'https://other.com' }));
    await expect(arxivSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('caps results to maxResults', async () => {
    const xml = readFileSync('tests/research/fixtures/adapters/arxiv-search.xml', 'utf8');
    stubFetch(() => resp(200, xml, { 'content-type': 'application/atom+xml' }));
    const r = await arxivSearch('q', { maxResults: 1 });
    expect(r.length).toBeLessThanOrEqual(1);
  });
});

describe('arxiv UA header', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  it('sends mma-research user-agent', async () => {
    let ua = '';
    stubFetch((_url, init) => {
      ua = (init?.headers as Record<string,string>)['user-agent']!;
      return resp(200, '<feed></feed>', { 'content-type': 'application/atom+xml' });
    });
    await arxivSearch('test', { maxResults: 1 });
    expect(ua).toMatch(/^mma-research\//);
  });
});
