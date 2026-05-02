import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { arxivSearch } from '../../../packages/core/src/research/adapters/arxiv.js';

describe('arxivSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  it('parses Atom XML into AdapterResult[]', async () => {
    const xml = readFileSync('tests/research/fixtures/adapters/arxiv-search.xml', 'utf8');
    agent.get('https://export.arxiv.org').intercept({ path: /\/api\/query/ })
      .reply(200, xml, { headers: { 'content-type': 'application/atom+xml' } });
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
    agent.get('https://export.arxiv.org').intercept({ path: /\/api\/query/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(arxivSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('caps results to maxResults', async () => {
    const xml = readFileSync('tests/research/fixtures/adapters/arxiv-search.xml', 'utf8');
    agent.get('https://export.arxiv.org').intercept({ path: /\/api\/query/ })
      .reply(200, xml, { headers: { 'content-type': 'application/atom+xml' } });
    const r = await arxivSearch('q', { maxResults: 1 });
    expect(r.length).toBeLessThanOrEqual(1);
  });
});
