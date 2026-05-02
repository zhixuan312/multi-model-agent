import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { webFetch } from '../../packages/core/src/research/web-fetch.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({}).fetch;
const allowlist = new Set(['example.com']);
const html = readFileSync('tests/research/fixtures/injection/html-with-instructions.html', 'utf8');

describe('untrusted-content delimiters defang prompt injection at the tool layer', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('wraps fetched HTML in <external-content trustLevel="untrusted">', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/x' })
      .reply(200, html, { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/x',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toMatch(/^<external-content/);
      expect(r.body).toMatch(/trustLevel="untrusted"/);
      // Inner < and > escaped so the inner </external-content> can't terminate the outer wrapper
      expect(r.body).not.toMatch(/<\/external-content><\/external-content>$/);
    }
  });

  it('strips HTML comments so instruction-like payloads cannot reach the worker', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/x' })
      .reply(200, html, { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/x',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      // HTML comment syntax must not appear in the wrapped body — Readability
      // strips comment nodes, so instruction-like payloads in comments are removed
      expect(r.body).not.toContain('<!--');
      expect(r.body).not.toContain('-->');
      // Normal article text is still extracted
      expect(r.body).toContain('Welcome');
      expect(r.body).toContain('interesting topic');
    }
  });

  it('strips script tags so they cannot execute in worker context', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/x' })
      .reply(200, html, { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/x',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      // <script> tags must not appear in the wrapped body — Readability strips
      // them, and even if they survived, escapeBody would defang them
      expect(r.body).not.toMatch(/<script>/i);
      expect(r.body).not.toMatch(/<\/script>/i);
      // Normal article text is still extracted
      expect(r.body).toContain('Welcome');
    }
  });
});
