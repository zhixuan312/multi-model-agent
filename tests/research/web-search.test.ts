import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { saveFetch, restoreFetch, stubFetch, resp } from './fixtures/mock-fetch.js';
import { BraveClient } from '../../packages/core/src/research/web-search.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1', 'k2', 'k3'] } }).brave;

// Deterministic sleep + random for fast, predictable tests.
const instantSleep = () => Promise.resolve();
const fixedRandom = () => 0.5;

function makeClient(overrides?: Partial<typeof cfg>) {
  return new BraveClient({ ...cfg, ...overrides }, { sleep: instantSleep, random: fixedRandom });
}

function token(init?: RequestInit): string {
  return String((init?.headers as Record<string, string> | undefined)?.['x-subscription-token'] ?? '');
}

// Persistent stub: every call succeeds (200, empty results); records the token used.
function stubSuccess(collect?: string[]) {
  stubFetch((_url, init) => {
    collect?.push(token(init));
    return resp(200, JSON.stringify({ web: { results: [] } }));
  });
}

// Persistent stub: every call returns 429; records the token used.
function stub429(collect?: string[]) {
  stubFetch((_url, init) => {
    collect?.push(token(init));
    return resp(429, '{}');
  });
}

describe('BraveClient', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  // ---- rotation ----

  it('round-robins API keys across sequential calls', async () => {
    const used: string[] = [];
    stubSuccess(used);
    const c = makeClient();
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    expect(used).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
  });

  it('round-robins API keys across concurrent calls', async () => {
    const used: string[] = [];
    stubSuccess(used);
    const c = makeClient();
    await Promise.all([0, 1, 2, 3, 4, 5].map(i => c.search('q' + i)));
    expect(used.filter(k => k === 'k1').length).toBe(2);
    expect(used.filter(k => k === 'k2').length).toBe(2);
    expect(used.filter(k => k === 'k3').length).toBe(2);
  });

  // ---- per-key spacing (1 req/s/token burst guard) ----

  it('spaces repeat requests on the same key by minPerKeyIntervalMs', async () => {
    const sleeps: number[] = [];
    stubSuccess();
    const c = new BraveClient(
      { ...cfg, minPerKeyIntervalMs: 1100 },
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: fixedRandom },
    );
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    const spacingWaits = sleeps.filter((ms) => ms > 0);
    expect(spacingWaits.length).toBe(3);
    for (const w of spacingWaits) expect(w).toBeGreaterThan(1000);
  });

  it('minPerKeyIntervalMs=0 disables the spacing gate', async () => {
    const sleeps: number[] = [];
    stubSuccess();
    const c = new BraveClient(
      { ...cfg, minPerKeyIntervalMs: 0 },
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: fixedRandom },
    );
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    expect(sleeps.filter((ms) => ms > 0).length).toBe(0);
  });

  // ---- 429 escalation ----

  it('on 429 advances to next key (within the per-call attempt budget)', async () => {
    const used: string[] = [];
    let n = 0;
    stubFetch((_url, init) => {
      used.push(token(init));
      return n++ < 2 ? resp(429, '{}') : resp(200, JSON.stringify({ web: { results: [] } }));
    });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
    expect(used).toEqual(['k1', 'k2', 'k3']);
  });

  it('all-keys-failed throws with exhausted code', async () => {
    stub429();
    const c = makeClient();
    await expect(c.search('q')).rejects.toThrow(/brave_keys_exhausted/);
  });

  it('caps per-call attempts to 4 even with many keys', async () => {
    const manyKeysCfg = ResearchConfigSchema.parse({
      brave: { apiKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    }).brave;
    const used: string[] = [];
    stub429(used);
    const c = new BraveClient(manyKeysCfg, { sleep: instantSleep, random: fixedRandom });
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(String(caught)).toMatch(/brave_keys_exhausted/);
    expect(used).toEqual(['a', 'b', 'c', 'd']);
  });

  // ---- success shape ----

  it('reports the keyIndex used for diagnostics', async () => {
    stubSuccess();
    const c = makeClient();
    const r = await c.search('q');
    expect(r.keyIndex).toBe(0);
  });

  it('returns sanitized results for valid Brave response', async () => {
    stubFetch(() => resp(200, JSON.stringify({ web: { results: [{ title: 'T', url: 'https://a.com', snippet: 'S' }] } })));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([{ title: 'T', url: 'https://a.com', snippet: 'S' }]);
  });

  // ---- malformed responses ----

  it('handles null response body', async () => {
    stubFetch(() => resp(200, 'null'));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('handles missing web field', async () => {
    stubFetch(() => resp(200, '{}'));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('handles non-array results', async () => {
    stubFetch(() => resp(200, JSON.stringify({ web: { results: 'not-an-array' } })));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('fills missing fields in result entries with safe defaults', async () => {
    stubFetch(() => resp(200, JSON.stringify({ web: { results: [{ title: 'ok' }, { url: 'https://b.com' }, {}] } })));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toHaveLength(3);
    expect(r.results[0]).toEqual({ title: 'ok', url: '', snippet: '' });
    expect(r.results[1]).toEqual({ title: '[missing title 1]', url: 'https://b.com', snippet: '' });
    expect(r.results[2]).toEqual({ title: '[missing title 2]', url: '', snippet: '' });
  });

  it('handles non-object result entries', async () => {
    stubFetch(() => resp(200, JSON.stringify({ web: { results: ['string', 42, null] } })));
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([
      { title: '[invalid entry 0]', url: '', snippet: '' },
      { title: '[invalid entry 1]', url: '', snippet: '' },
      { title: '[invalid entry 2]', url: '', snippet: '' },
    ]);
  });

  it('handles invalid JSON body gracefully', async () => {
    stubFetch(() => resp(200, 'not-json'));
    const c = makeClient();
    await expect(c.search('q')).rejects.toThrow(/brave_keys_exhausted/);
  });

  // ---- zero keys ----

  it('throws brave_not_configured when apiKeys is empty', async () => {
    const emptyCfg = ResearchConfigSchema.parse({ brave: { apiKeys: [] } }).brave;
    const c = new BraveClient(emptyCfg);
    await expect(c.search('q')).rejects.toThrow(/brave_not_configured/);
  });

  // ---- deadline ----

  it('throws brave_deadline_exceeded when deadline has already passed', async () => {
    const c = new BraveClient(
      { ...cfg, timeoutMs: -1 } as any,
      { sleep: instantSleep, random: fixedRandom },
    );
    await expect(c.search('q')).rejects.toThrow(/brave_deadline_exceeded/);
  });

  it('does not sleep after the final failed attempt', async () => {
    const sleeps: number[] = [];
    const c = new BraveClient(
      { ...cfg, perCallBackoffMs: 200, timeoutMs: 30000 },
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: fixedRandom },
    );
    stub429();
    try { await c.search('q'); } catch { /* expected */ }
    expect(sleeps.length).toBe(2);
  });
});

describe('Brave UA header', () => {
  beforeEach(() => { saveFetch(); });
  afterEach(() => { restoreFetch(); });

  it('sends mma-research user-agent', async () => {
    let ua = '';
    stubFetch((_url, init) => {
      ua = (init?.headers as Record<string, string>)['user-agent']!;
      return resp(200, JSON.stringify({ web: { results: [] } }));
    });
    const client = new BraveClient({
      apiKeys: ['k1'], timeoutMs: 5000, maxResultsPerQuery: 5, perCallBackoffMs: 100,
    } as any);
    await client.search('test');
    expect(ua).toMatch(/^mma-research\//);
  });
});
