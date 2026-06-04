import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BraveClient } from '../../packages/core/src/research/web-search.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1', 'k2', 'k3'] } }).brave;

// Deterministic sleep + random for fast, predictable tests.
const instantSleep = () => Promise.resolve();
const fixedRandom = () => 0.5;

function makeClient(overrides?: Partial<typeof cfg>) {
  return new BraveClient({ ...cfg, ...overrides }, { sleep: instantSleep, random: fixedRandom });
}

function stubSuccess(agent: MockAgent, collect?: string[]) {
  agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/, method: 'GET' })
    .reply((req) => {
      collect?.push(String((req.headers as any)['x-subscription-token'] ?? ''));
      return { statusCode: 200, data: JSON.stringify({ web: { results: [] } }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
}

function stub429(agent: MockAgent, times: number, collect?: string[]) {
  agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
    .reply((req) => {
      collect?.push(String((req.headers as any)['x-subscription-token']));
      return { statusCode: 429, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
    }).times(times);
}

describe('BraveClient', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  // ---- rotation ----

  it('round-robins API keys across sequential calls', async () => {
    const used: string[] = [];
    for (let i = 0; i < 6; i++) stubSuccess(agent, used);
    const c = makeClient();
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    expect(used).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
  });

  it('round-robins API keys across concurrent calls', async () => {
    const used: string[] = [];
    for (let i = 0; i < 6; i++) stubSuccess(agent, used);
    const c = makeClient();
    await Promise.all([0, 1, 2, 3, 4, 5].map(i => c.search('q' + i)));
    // With 3 keys and 6 concurrent calls, each key should be used exactly twice.
    expect(used.filter(k => k === 'k1').length).toBe(2);
    expect(used.filter(k => k === 'k2').length).toBe(2);
    expect(used.filter(k => k === 'k3').length).toBe(2);
  });

  // ---- per-key spacing (1 req/s/token burst guard) ----

  it('spaces repeat requests on the same key by minPerKeyIntervalMs', async () => {
    const sleeps: number[] = [];
    for (let i = 0; i < 6; i++) stubSuccess(agent);
    const c = new BraveClient(
      { ...cfg, minPerKeyIntervalMs: 1100 },
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: fixedRandom },
    );
    // 6 calls over 3 keys: calls 1-3 use fresh keys (no wait); calls 4-6 reuse
    // k1/k2/k3 and must wait ~the full interval (the no-op sleep advances no
    // real clock, so `last + interval` stays ~interval ahead of now).
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    const spacingWaits = sleeps.filter((ms) => ms > 0);
    expect(spacingWaits.length).toBe(3);
    for (const w of spacingWaits) expect(w).toBeGreaterThan(1000);
  });

  it('minPerKeyIntervalMs=0 disables the spacing gate', async () => {
    const sleeps: number[] = [];
    for (let i = 0; i < 6; i++) stubSuccess(agent);
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
    stub429(agent, 2, used);
    stubSuccess(agent, used);
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
    expect(used).toEqual(['k1', 'k2', 'k3']);
  });

  it('all-keys-failed throws with exhausted code', async () => {
    stub429(agent, 20);
    const c = makeClient();
    await expect(c.search('q')).rejects.toThrow(/brave_keys_exhausted/);
  });

  it('caps per-call attempts to 4 even with many keys', async () => {
    const manyKeysCfg = ResearchConfigSchema.parse({
      brave: { apiKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    }).brave;
    const used: string[] = [];
    // All keys 429 — should stop after 4 attempts, not 7.
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply((req) => {
        used.push(String((req.headers as any)['x-subscription-token']));
        return { statusCode: 429, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
      }).times(20);
    const c = new BraveClient(manyKeysCfg, { sleep: instantSleep, random: fixedRandom });
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(String(caught)).toMatch(/brave_keys_exhausted/);
    // Exactly 4 attempts, using keys a-d (indices 0-3).
    expect(used).toEqual(['a', 'b', 'c', 'd']);
  });

  // ---- success shape ----

  it('reports the keyIndex used for diagnostics', async () => {
    stubSuccess(agent);
    const c = makeClient();
    const r = await c.search('q');
    expect(r.keyIndex).toBe(0);
  });

  it('returns sanitized results for valid Brave response', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, JSON.stringify({
        web: { results: [{ title: 'T', url: 'https://a.com', snippet: 'S' }] },
      }), { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([{ title: 'T', url: 'https://a.com', snippet: 'S' }]);
  });

  // ---- malformed responses ----

  it('handles null response body', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, 'null', { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('handles missing web field', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, '{}', { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('handles non-array results', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, JSON.stringify({ web: { results: 'not-an-array' } }),
             { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([]);
  });

  it('fills missing fields in result entries with safe defaults', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, JSON.stringify({
        web: { results: [{ title: 'ok' }, { url: 'https://b.com' }, {}] },
      }), { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toHaveLength(3);
    expect(r.results[0]).toEqual({ title: 'ok', url: '', snippet: '' });
    expect(r.results[1]).toEqual({ title: '[missing title 1]', url: 'https://b.com', snippet: '' });
    expect(r.results[2]).toEqual({ title: '[missing title 2]', url: '', snippet: '' });
  });

  it('handles non-object result entries', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, JSON.stringify({ web: { results: ['string', 42, null] } }),
             { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    const r = await c.search('q');
    expect(r.results).toEqual([
      { title: '[invalid entry 0]', url: '', snippet: '' },
      { title: '[invalid entry 1]', url: '', snippet: '' },
      { title: '[invalid entry 2]', url: '', snippet: '' },
    ]);
  });

  it('handles invalid JSON body gracefully', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, 'not-json', { headers: { 'content-type': 'application/json' } });
    const c = makeClient();
    // Invalid JSON throws during res.body.json() → caught as 'error' attempt
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
    // Negative timeout makes deadline always in the past.
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
    stub429(agent, 20);
    try { await c.search('q'); } catch { /* expected */ }
    // With 3 keys → maxAttempts=3. Should sleep after attempt 0 and attempt 1, but NOT after attempt 2.
    expect(sleeps.length).toBe(2);
  });
});

describe('Brave UA header', () => {
  it('sends mma-research user-agent', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    let ua = '';
    agent.get('https://api.search.brave.com')
      .intercept({ path: /\/res\/v1\/web\/search/ })
      .reply((opts) => {
        ua = (opts.headers as Record<string,string>)['user-agent']!;
        return { statusCode: 200, data: JSON.stringify({ web: { results: [] } }) };
      });
    const client = new BraveClient({
      apiKeys: ['k1'], timeoutMs: 5000, maxResultsPerQuery: 5, perCallBackoffMs: 100,
    });
    await client.search('test');
    await agent.close();
    expect(ua).toMatch(/^mma-research\//);
  });
});
