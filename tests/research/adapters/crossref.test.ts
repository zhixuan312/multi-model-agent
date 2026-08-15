import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { fullyRendered } from '../../helpers/rendered-error.js';
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

  /**
   * The contact email must not appear anywhere on the error, and the call must actually fail.
   *
   * This asserted inside a bare `catch`, so a run where the adapter did NOT throw skipped the
   * assertion entirely and reported a pass — in a test whose whole job is proving a secret did
   * not escape. It also read only `.message`: the email is in the request URL, and undici puts
   * request detail on `cause`, which `String(err)` never shows.
   */
  it('keeps the contact email off the error, and does fail', async () => {
    agent.get('https://api.crossref.org').intercept({ path: /\/works/ })
      .reply(500, '{}');
    const caught = await crossrefSearch('q', { contactEmail: 'secret@example.com' })
      .then(() => null, (e: unknown) => e);
    expect(caught, 'the adapter resolved on a 500 — nothing was verified about leaking').not.toBeNull();

    // Both spellings. The email reaches the wire through `URLSearchParams`, which percent-encodes
    // `@`, so a leaked URL reads `secret%40example.com` — checking only the raw address misses
    // the exact form a leak would take. (Found by planting the leak: the raw-only assertion
    // stayed green.)
    const rendered = fullyRendered(caught);
    expect(rendered).not.toContain('secret@example.com');
    expect(rendered).not.toContain(encodeURIComponent('secret@example.com'));
  });
});
