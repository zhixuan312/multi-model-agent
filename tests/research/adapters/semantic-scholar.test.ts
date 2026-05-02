import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { semanticScholarSearch } from '../../../packages/core/src/research/adapters/semantic-scholar.js';

describe('semanticScholarSearch', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  it('parses JSON into AdapterResult[]', async () => {
    const json = readFileSync('tests/research/fixtures/adapters/semantic-scholar.json', 'utf8');
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(200, json, { headers: { 'content-type': 'application/json' } });
    const r = await semanticScholarSearch('regime detection');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].adapterId).toBe('semantic_scholar');
  });

  it('handles 429 by throwing rate-limit error', async () => {
    agent.get('https://api.semanticscholar.org').intercept({ path: /\/graph\/v1\/paper\/search/ })
      .reply(429, '{}', { headers: { 'content-type': 'application/json' } });
    await expect(semanticScholarSearch('q')).rejects.toThrow(/semantic_scholar_rate_limited/);
  });
});
