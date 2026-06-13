import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { pubmedSearch } from '../../../packages/core/src/research/adapters/pubmed.js';

describe('pubmedSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  const esearch = readFileSync('tests/research/fixtures/adapters/pubmed-esearch.json', 'utf8');
  const esummary = readFileSync('tests/research/fixtures/adapters/pubmed-esummary.json', 'utf8');

  function stubBoth(a: MockAgent) {
    a.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(200, esearch, { headers: { 'content-type': 'application/json' } });
    a.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esummary/ })
      .reply(200, esummary, { headers: { 'content-type': 'application/json' } });
  }

  it('parses two-step response into AdapterResult[]', async () => {
    stubBoth(agent);
    const r = await pubmedSearch('CRISPR nanoparticle');
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({
      adapterId: 'pubmed',
      recordId: '39012345',
      title: 'CRISPR-based gene therapy delivery using lipid nanoparticles',
      url: 'https://pubmed.ncbi.nlm.nih.gov/39012345',
      publishedAt: '2026-03-01',
    });
  });

  it('parses year-only pubdate', async () => {
    stubBoth(agent);
    const r = await pubmedSearch('q');
    const yearOnly = r.find(x => x.recordId === '38901234');
    expect(yearOnly!.publishedAt).toBe('2025-01-01');
  });

  it('snippet equals title (esummary has no abstract)', async () => {
    stubBoth(agent);
    const r = await pubmedSearch('q');
    expect(r[0]!.snippet).toBe(r[0]!.title);
  });

  it('appends api_key when provided', async () => {
    let searchPath = '';
    let summaryPath = '';
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply((req) => {
        searchPath = req.path;
        return { statusCode: 200, data: esearch, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esummary/ })
      .reply((req) => {
        summaryPath = req.path;
        return { statusCode: 200, data: esummary, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    await pubmedSearch('q', { apiKey: 'test-key-123' });
    expect(searchPath).toContain('api_key=test-key-123');
    expect(summaryPath).toContain('api_key=test-key-123');
  });

  it('omits api_key when not provided', async () => {
    let searchPath = '';
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply((req) => {
        searchPath = req.path;
        return { statusCode: 200, data: esearch, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esummary/ })
      .reply(200, esummary, { headers: { 'content-type': 'application/json' } });
    await pubmedSearch('q');
    expect(searchPath).not.toContain('api_key');
  });

  it('returns [] when esearch returns empty idlist', async () => {
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(200, JSON.stringify({ esearchresult: { idlist: [] } }), { headers: { 'content-type': 'application/json' } });
    const r = await pubmedSearch('nonexistent topic');
    expect(r).toEqual([]);
  });

  it('throws on redirect', async () => {
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(pubmedSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('throws on non-200 from esearch', async () => {
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(500, '{}');
    await expect(pubmedSearch('q')).rejects.toThrow(/pubmed_http_500/);
  });

  it('throws on non-200 from esummary', async () => {
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(200, esearch, { headers: { 'content-type': 'application/json' } });
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esummary/ })
      .reply(429, '{}');
    await expect(pubmedSearch('q')).rejects.toThrow(/pubmed_http_429/);
  });

  it('does not include raw URL with api_key in error messages', async () => {
    agent.get('https://eutils.ncbi.nlm.nih.gov').intercept({ path: /esearch/ })
      .reply(500, '{}');
    try {
      await pubmedSearch('q', { apiKey: 'secret-key-123' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-key-123');
    }
  });
});
