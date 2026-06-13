import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { crossrefSearch } from '../../../packages/core/src/research/adapters/crossref.js';

describe('crossrefSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  const fixture = readFileSync('tests/research/fixtures/adapters/crossref.json', 'utf8');

  it('parses JSON into AdapterResult[]', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await crossrefSearch('stablecoin');
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({
      adapterId: 'crossref',
      title: 'Stablecoin Adoption in Emerging Markets',
      url: 'https://doi.org/10.1234/example.2021.001',
      publishedAt: '2021-06-15',
    });
    expect(r[0]!.snippet).toContain('stablecoins across emerging economies');
  });

  it('falls back to subtitle when abstract is missing', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await crossrefSearch('q');
    const noAbstract = r.find(x => x.title === 'Central Bank Digital Currencies: A Review');
    expect(noAbstract!.snippet).toBe('');
  });

  it('parses year-only date-parts', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await crossrefSearch('q');
    const yearOnly = r.find(x => x.title === 'Central Bank Digital Currencies: A Review');
    expect(yearOnly!.publishedAt).toBe('2023-01-01');
  });

  it('appends mailto when contactEmail is provided', async () => {
    let capturedPath = '';
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply((req) => {
        capturedPath = req.path;
        return { statusCode: 200, data: fixture, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    await crossrefSearch('q', { contactEmail: 'test@example.com' });
    expect(capturedPath).toContain('mailto=test%40example.com');
  });

  it('omits mailto when contactEmail is absent', async () => {
    let capturedPath = '';
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply((req) => {
        capturedPath = req.path;
        return { statusCode: 200, data: fixture, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    await crossrefSearch('q');
    expect(capturedPath).not.toContain('mailto');
  });

  it('throws on redirect', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(crossrefSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('throws on non-200', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(429, '{}');
    await expect(crossrefSearch('q')).rejects.toThrow(/crossref_http_429/);
  });

  it('does not include raw URL with mailto in error messages', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(500, '{}');
    try {
      await crossrefSearch('q', { contactEmail: 'secret@example.com' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret@example.com');
    }
  });
});
