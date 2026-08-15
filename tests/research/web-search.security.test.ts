import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BraveClient } from '../../packages/core/src/research/web-search.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';
import { fullyRendered } from '../helpers/rendered-error.js';

const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['SECRET-K1'] } }).brave;



const instantSleep = () => Promise.resolve();
const fixedRandom = () => 0.5;

describe('BraveClient — key leak prevention', () => {
  let agent: MockAgent;
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
  afterEach(async () => { await agent.close(); });

  it('error messages never include the key value', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(500, '{"error":"oops with SECRET-K1 in body"}',
             { headers: { 'content-type': 'application/json' } }).times(20);
    const c = new BraveClient(cfg, { sleep: instantSleep, random: fixedRandom });
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(fullyRendered(caught)).not.toContain('SECRET-K1');
  });

  it('exhausted error only includes key indices, not key values', async () => {
    agent.get('https://api.search.brave.com').intercept({ path: /\/res\/v1\/web\/search/ })
      .reply(429, '{}', { headers: { 'content-type': 'application/json' } }).times(20);
    const c = new BraveClient(cfg, { sleep: instantSleep, random: fixedRandom });
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    const msg = fullyRendered(caught);
    expect(msg).toMatch(/brave_keys_exhausted/);
    expect(msg).not.toContain('SECRET-K1');
    expect(msg).toContain('lastKeyIndex=0');
  });

  it('deadline error does not leak key values', async () => {
    const c = new BraveClient(
      { ...cfg, timeoutMs: -1 } as any,
      { sleep: instantSleep, random: fixedRandom },
    );
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(fullyRendered(caught)).not.toContain('SECRET-K1');
    expect(String(caught)).toMatch(/brave_deadline_exceeded/);
  });

  // Renamed from "does not leak keys (none configured anyway)" — with no keys configured there
  // was nothing that could leak, so that half of the name described a check the case could not
  // perform. What it does verify is that an unconfigured client fails fast with a named code
  // rather than reaching the network, which is worth having on its own.
  it('fails with a named code when no key is configured', async () => {
    const emptyCfg = ResearchConfigSchema.parse({ brave: { apiKeys: [] } }).brave;
    const c = new BraveClient(emptyCfg);
    let caught: unknown;
    try { await c.search('q'); } catch (e) { caught = e; }
    expect(String(caught)).toMatch(/brave_not_configured/);
  });
});
