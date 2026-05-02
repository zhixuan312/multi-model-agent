import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { semanticScholarSearch } from '../../../packages/core/src/research/adapters/semantic-scholar.js';

describe('semanticScholarSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  const fixtureJson = readFileSync('tests/research/fixtures/adapters/semantic-scholar.json', 'utf8');

  function intercept200(body: string) {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(200, body, { headers: { 'content-type': 'application/json' } });
  }

  function interceptStatus(status: number, body?: string) {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(status, body ?? '{}', { headers: { 'content-type': 'application/json' } });
  }

  // ---- happy path ----

  it('parses JSON into AdapterResult[]', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('regime detection');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].adapterId).toBe('semantic_scholar');
  });

  it('maps fields correctly: recordId, title, url, snippet, publishedAt, raw', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('regime detection');
    expect(r[0]).toMatchObject({
      adapterId: 'semantic_scholar',
      recordId: 'abc',
      title: 'Regime Detection in Financial Markets',
      url: 'https://www.semanticscholar.org/paper/abc',
      snippet: expect.stringContaining('hidden Markov'),
      publishedAt: '2024-01-01',
      raw: expect.any(Object),
    });
  });

  it('omits publishedAt when year is missing', async () => {
    intercept200(JSON.stringify({
      total: 1, offset: 0,
      data: [{ paperId: 'p1', title: 'T', abstract: 'A.' }],
    }));
    const r = await semanticScholarSearch('q');
    expect(r[0].publishedAt).toBeUndefined();
  });

  it('truncates snippet to 500 characters', async () => {
    const longAbstract = 'x'.repeat(600);
    intercept200(JSON.stringify({
      total: 1, offset: 0,
      data: [{ paperId: 'p1', title: 'T', abstract: longAbstract }],
    }));
    const r = await semanticScholarSearch('q');
    expect(r[0].snippet.length).toBe(500);
  });

  it('sets snippet to empty string when abstract is missing', async () => {
    intercept200(JSON.stringify({
      total: 1, offset: 0,
      data: [{ paperId: 'p1', title: 'T' }],
    }));
    const r = await semanticScholarSearch('q');
    expect(r[0].snippet).toBe('');
  });

  // ---- URL fallback ----

  it('constructs fallback URL from paperId when url is missing', async () => {
    intercept200(JSON.stringify({
      total: 1, offset: 0,
      data: [{ paperId: 'abc123', title: 'T' }],
    }));
    const r = await semanticScholarSearch('q');
    expect(r[0].url).toBe('https://www.semanticscholar.org/paper/abc123');
  });

  it('uses api url when provided', async () => {
    intercept200(JSON.stringify({
      total: 1, offset: 0,
      data: [{ paperId: 'abc123', title: 'T', url: 'https://example.com/paper' }],
    }));
    const r = await semanticScholarSearch('q');
    expect(r[0].url).toBe('https://example.com/paper');
  });

  // ---- maxResults clamping ----

  it('caps results to maxResults', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('q', { maxResults: 1 });
    expect(r.length).toBeLessThanOrEqual(1);
  });

  it('clamps maxResults lower bound to 1', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('q', { maxResults: 0 });
    expect(r.length).toBeLessThanOrEqual(1);
  });

  it('clamps maxResults upper bound to 25', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('q', { maxResults: 100 });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('defaults maxResults to 10 when not specified', async () => {
    intercept200(fixtureJson);
    const r = await semanticScholarSearch('q');
    expect(r.length).toBe(2);
  });

  // ---- empty / missing data ----

  it('returns [] for empty data array', async () => {
    intercept200(JSON.stringify({ total: 0, offset: 0, data: [] }));
    const r = await semanticScholarSearch('q');
    expect(r).toEqual([]);
  });

  it('returns [] for missing data field', async () => {
    intercept200(JSON.stringify({ total: 0, offset: 0 }));
    const r = await semanticScholarSearch('q');
    expect(r).toEqual([]);
  });

  it('returns [] for unexpected response shape', async () => {
    intercept200(JSON.stringify({ foo: 'bar' }));
    const r = await semanticScholarSearch('q');
    expect(r).toEqual([]);
  });

  // ---- null safety ----

  it('filters out records with missing paperId', async () => {
    intercept200(JSON.stringify({
      total: 2, offset: 0,
      data: [
        { paperId: 'good', title: 'Keep' },
        { title: 'Drop' },
      ],
    }));
    const r = await semanticScholarSearch('q');
    expect(r.length).toBe(1);
    expect(r[0].recordId).toBe('good');
  });

  it('filters out records with empty paperId', async () => {
    intercept200(JSON.stringify({
      total: 2, offset: 0,
      data: [
        { paperId: '', title: 'Drop' },
        { paperId: 'good', title: 'Keep' },
      ],
    }));
    const r = await semanticScholarSearch('q');
    expect(r.length).toBe(1);
  });

  it('filters out records with missing title', async () => {
    intercept200(JSON.stringify({
      total: 2, offset: 0,
      data: [
        { paperId: 'p1', title: 'Keep' },
        { paperId: 'p2' },
      ],
    }));
    const r = await semanticScholarSearch('q');
    expect(r.length).toBe(1);
  });

  it('filters out records with empty title', async () => {
    intercept200(JSON.stringify({
      total: 2, offset: 0,
      data: [
        { paperId: 'p1', title: '   ' },
        { paperId: 'p2', title: 'Keep' },
      ],
    }));
    const r = await semanticScholarSearch('q');
    expect(r.length).toBe(1);
  });

  // ---- error handling ----

  it('handles 429 by throwing rate-limit error', async () => {
    interceptStatus(429);
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_rate_limited/);
  });

  it('handles 302 redirect by throwing redirect error', async () => {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(302, '', { headers: { location: 'https://other.com' } });
    await expect(semanticScholarSearch('q')).rejects.toThrow(/adapter_unexpected_redirect/);
  });

  it('handles 500 by throwing http error', async () => {
    interceptStatus(500);
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_http_500/);
  });

  it('handles 503 by throwing http error', async () => {
    interceptStatus(503);
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_http_503/);
  });

  it('handles malformed JSON', async () => {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(200, 'not json', { headers: { 'content-type': 'application/json' } });
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_parse_error/);
  });

  it('handles network failure with adapter context', async () => {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .replyWithError(new Error('ECONNREFUSED'));
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_request_failed.*ECONNREFUSED/);
  });
});
