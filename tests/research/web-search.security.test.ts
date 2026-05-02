import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BraveClient } from '../../packages/core/src/research/web-search.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['SECRET-K1'] } }).brave;

describe('BraveClient — key leak prevention', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  it('error messages never include the key value', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(500, '{"error":"oops with SECRET-K1 in body"}',
             { headers: { 'content-type': 'application/json' } }).times(20);
    const c = new BraveClient(cfg);
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(String(caught)).not.toContain('SECRET-K1');
  });
});
