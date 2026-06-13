import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { openalexSearch } from '../../../packages/core/src/research/adapters/openalex.js';

describe('openalexSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  const fixture = readFileSync('tests/research/fixtures/adapters/openalex.json', 'utf8');

  it('parses JSON into AdapterResult[]', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await openalexSearch('protein structure');
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({
      adapterId: 'openalex',
      title: 'Highly accurate protein structure prediction with AlphaFold',
      url: 'https://doi.org/10.1038/s41586-021-03819-2',
      publishedAt: '2021-01-01',
    });
    expect(r[0]!.snippet).toContain('Proteins are essential to life');
  });

  it('uses openalex id as URL when DOI is null', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await openalexSearch('deep learning');
    const noDoi = r.find(x => x.title === 'A survey of deep learning methods');
    expect(noDoi!.url).toBe('https://openalex.org/W123456789');
  });

  it('handles empty abstract_inverted_index', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(200, fixture, { headers: { 'content-type': 'application/json' } });
    const r = await openalexSearch('q');
    const noAbstract = r.find(x => x.title === 'A survey of deep learning methods');
    expect(noAbstract!.snippet).toBe('');
  });

  it('appends mailto when contactEmail is provided', async () => {
    let capturedPath = '';
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply((req) => {
        capturedPath = req.path;
        return { statusCode: 200, data: fixture, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    await openalexSearch('q', { contactEmail: 'test@example.com' });
    expect(capturedPath).toContain('mailto=test%40example.com');
  });

  it('omits mailto when contactEmail is absent', async () => {
    let capturedPath = '';
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply((req) => {
        capturedPath = req.path;
        return { statusCode: 200, data: fixture, responseOptions: { headers: { 'content-type': 'application/json' } } };
      });
    await openalexSearch('q');
    expect(capturedPath).not.toContain('mailto');
  });

  it('throws on redirect', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(openalexSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('throws on non-200', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(500, '{}');
    await expect(openalexSearch('q')).rejects.toThrow(/openalex_http_500/);
  });

  it('does not include raw URL with mailto in error messages', async () => {
    agent.get('https://api.openalex.org').intercept({ path: /\/works/ })
      .reply(500, '{}');
    try {
      await openalexSearch('q', { contactEmail: 'secret@example.com' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret@example.com');
    }
  });
});
