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

  // Named for what it asserts. It used to be called "returns [] on unexpected redirect" while
  // asserting the opposite — the adapter REJECTS, and a caller who believed the name would have
  // written `const r = await arxivSearch(...)` with no catch.
  it('rejects on an unexpected redirect rather than following it', async () => {
    agent.get('https://export.arxiv.org').intercept({ path: /\/api\/query/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(arxivSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('caps results to maxResults', async () => {
    const xml = readFileSync('tests/research/fixtures/adapters/arxiv-search.xml', 'utf8');
    agent.get('https://export.arxiv.org').intercept({ path: /\/api\/query/ })
      .reply(200, xml, { headers: { 'content-type': 'application/atom+xml' } });
    const r = await arxivSearch('q', { maxResults: 1 });
    // Exactly one, not "at most one". The fixture carries three entries, so `toBeLessThanOrEqual`
    // was also satisfied by a parse that returned nothing at all — the cap and a total failure
    // were indistinguishable.
    expect(r).toHaveLength(1);
  });
});

describe('arxiv UA header', () => {
  it('sends mma-research user-agent', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    let ua = '';
    agent.get('https://export.arxiv.org')
      .intercept({ path: /\/api\/query/ })
      .reply((opts) => {
        ua = (opts.headers as Record<string,string>)['user-agent']!;
        return { statusCode: 200, data: '<feed></feed>' };
      });
    await arxivSearch('test', { maxResults: 1 });
    await agent.close();
    expect(ua).toMatch(/^mma-research\//);
  });
});
