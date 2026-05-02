import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BraveClient } from '../../packages/core/src/research/web-search.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1', 'k2', 'k3'] } }).brave;

describe('BraveClient', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  it('round-robins API keys across sequential calls', async () => {
    const used: string[] = [];
    for (let i = 0; i < 6; i++) {
      agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/, method: 'GET' })
        .reply((req) => {
          used.push(String((req.headers as any)['x-subscription-token'] ?? ''));
          return { statusCode: 200, data: JSON.stringify({ web: { results: [] } }), responseOptions: { headers: { 'content-type': 'application/json' } } };
        });
    }
    const c = new BraveClient(cfg);
    for (let i = 0; i < 6; i++) await c.search('q' + i);
    expect(used).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
  });

  it('on 429 advances to next key (within the per-call attempt budget)', async () => {
    const used: string[] = [];
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply((req) => { used.push(String((req.headers as any)['x-subscription-token'])); return { statusCode: 429, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } }; }).times(2);
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply((req) => { used.push(String((req.headers as any)['x-subscription-token'])); return { statusCode: 200, data: JSON.stringify({ web: { results: [] } }), responseOptions: { headers: { 'content-type': 'application/json' } } }; });
    const c = new BraveClient(cfg);
    const r = await c.search('q');
    expect(r.results).toEqual([]);
    expect(used).toEqual(['k1', 'k2', 'k3']);
  });

  it('all-keys-failed throws with exhausted code', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(429, '{}', { headers: { 'content-type': 'application/json' } }).times(20);
    const c = new BraveClient(cfg);
    await expect(c.search('q')).rejects.toThrow(/brave_keys_exhausted/);
  });

  it('reports the keyIndex used for diagnostics', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(200, JSON.stringify({ web: { results: [] } }),
             { headers: { 'content-type': 'application/json' } });
    const c = new BraveClient(cfg);
    const r = await c.search('q');
    expect(r.keyIndex).toBe(0);
  });
});
