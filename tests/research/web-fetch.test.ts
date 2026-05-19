import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { webFetch } from '../../packages/core/src/research/web-fetch.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({}).fetch;
const allowlist = new Set(['example.com']);

describe('webFetch — happy path', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('returns extracted text wrapped in delimiters when host is allowed', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/article' })
      .reply(
        200,
        '<html><body><article>Hello world</article></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );

    const r = await webFetch({
      url: 'https://example.com/article',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    expect(r.body).toContain('Hello world');
    expect(r.body).toMatch(/^<external-content/);
    expect(r.host).toBe('example.com');
  });

  it('rejects off-allowlist host with web_fetch_off_allowlist', async () => {
    const r = await webFetch({
      url: 'https://other.com/x',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_off_allowlist');
  });

  it('rejects IP literal URLs', async () => {
    const r = await webFetch({
      url: 'https://8.8.8.8/page',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_ip_literal_blocked');
  });

  it('rejects non-HTTPS URLs', async () => {
    const r = await webFetch({
      url: 'http://example.com/page',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_invalid_scheme');
  });

  it('rejects invalid URLs', async () => {
    const r = await webFetch({
      url: 'not-a-url',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_invalid_url');
  });

  it('strips credentials from URL before any processing', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/secret' })
      .reply(
        200,
        '<html><body><p>secret page</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );

    const r = await webFetch({
      url: 'https://user:pass@example.com/secret',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.credentialsStripped).toBe(true);
    }
  });

  it('extracts text from plain text responses', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/data.txt' })
      .reply(
        200,
        'plain text content',
        { headers: { 'content-type': 'text/plain' } },
      );

    const r = await webFetch({
      url: 'https://example.com/data.txt',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('plain text content');
      expect(r.rawText).toBe('plain text content');
    }
  });

  it('extracts JSON and XML/Atom/RSS as rawText without Readability', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/feed.xml' })
      .reply(
        200,
        '<?xml version="1.0"?><rss><channel><item><title>Test</title></item></channel></rss>',
        { headers: { 'content-type': 'application/rss+xml' } },
      );

    const r = await webFetch({
      url: 'https://example.com/feed.xml',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.rawText).toContain('<rss>');
    }
  });

  it('rejects unsupported content types', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/file.pdf' })
      .reply(
        200,
        'binary-pdf-data',
        { headers: { 'content-type': 'application/pdf' } },
      );

    const r = await webFetch({
      url: 'https://example.com/file.pdf',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_unsupported_content_type');
  });

  it('truncates body at maxBodyBytes and sets truncated flag', async () => {
    const bigContent = 'x'.repeat(2000);
    const smallCfg = { ...cfg, maxBodyBytes: 100 };

    agent
      .get('https://example.com')
      .intercept({ path: '/big' })
      .reply(
        200,
        bigContent,
        { headers: { 'content-type': 'text/plain' } },
      );

    const r = await webFetch({
      url: 'https://example.com/big',
      cfg: smallCfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.truncated).toBe(true);
      expect(r.bytesReturned).toBeLessThanOrEqual(150);
    }
  });

  it('times out when request is aborted', async () => {
    const tinyCfg = { ...cfg, totalDeadlineMs: 5000, connectTimeoutMs: 1000 };

    agent
      .get('https://example.com')
      .intercept({ path: '/slow' })
      .replyWithError(new DOMException('The operation was aborted', 'AbortError'));

    const r = await webFetch({
      url: 'https://example.com/slow',
      cfg: tinyCfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_timeout');
  });

  it('maps request_failed when signal is not aborted', async () => {
    const tinyCfg = { ...cfg, totalDeadlineMs: 5000, connectTimeoutMs: 1000 };

    agent
      .get('https://example.com')
      .intercept({ path: '/aborted' })
      .replyWithError(new Error('mock error'));

    const r = await webFetch({
      url: 'https://example.com/aborted',
      cfg: tinyCfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_request_failed');
  });

  it('allows empty content-type header', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/no-ct' })
      .reply(200, '<html><body><p>no content type</p></body></html>', { headers: {} });

    const r = await webFetch({
      url: 'https://example.com/no-ct',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
  });

  it('treats non-2xx non-redirect status as successful fetch', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/not-found' })
      .reply(
        404,
        '<html><body><p>not found</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );

    const r = await webFetch({
      url: 'https://example.com/not-found',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    // Non-redirect status codes are fetched like any other response
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('not found');
    }
  });

  it('follows a valid redirect and fetches the final URL', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/start' })
      .reply(301, '', {
        headers: { location: 'https://example.com/end' },
      });
    agent
      .get('https://example.com')
      .intercept({ path: '/end' })
      .reply(200, '<html><body><p>final page</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/start',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('final page');
      expect(r.host).toBe('example.com');
    }
  });

  it('follows relative redirect Location', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/old' })
      .reply(301, '', {
        headers: { location: '/new' },
      });
    agent
      .get('https://example.com')
      .intercept({ path: '/new' })
      .reply(200, '<html><body><p>moved</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/old',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('moved');
    }
  });

  it('strips credentials from the initial URL in error paths too', async () => {
    const r = await webFetch({
      url: 'https://alice:token@other.com/private',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.credentialsStripped).toBe(true);
  });

  it('enforces totalDeadlineMs on hanging DNS resolution', async () => {
    const tinyCfg = { ...cfg, totalDeadlineMs: 200, connectTimeoutMs: 100 };

    // resolveIP never resolves — totalDeadlineMs should fire
    const r = await webFetch({
      url: 'https://example.com/hang',
      cfg: tinyCfg,
      hostAllowlist: allowlist,
      resolveIP: async () => new Promise(() => {}), // never resolves
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_timeout');
  });

  it('maps undici connect timeout errors to web_fetch_timeout', async () => {
    const err = new Error('Connect timeout');
    (err as { code: string }).code = 'UND_ERR_CONNECT_TIMEOUT';

    agent
      .get('https://example.com')
      .intercept({ path: '/slow-connect' })
      .replyWithError(err);

    const r = await webFetch({
      url: 'https://example.com/slow-connect',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_timeout');
  });

  it('maps undici headers timeout errors to web_fetch_timeout', async () => {
    const err = new Error('Headers timeout');
    (err as { code: string }).code = 'UND_ERR_HEADERS_TIMEOUT';

    agent
      .get('https://example.com')
      .intercept({ path: '/slow-headers' })
      .replyWithError(err);

    const r = await webFetch({
      url: 'https://example.com/slow-headers',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_timeout');
  });
});

describe('web-fetch — connect-callback SSRF guard (A7)', () => {
  it('aborts with web_fetch_ssrf_postresolve_block when DNS flips public→private', async () => {
    // Simulated: validateAndPinURL sees a public IP (1.2.3.4); injected resolveIP
    // returns a private 10.x at request time. The connect callback must abort.
    const r = await webFetch({
      url: 'https://example.com/path',
      cfg,
      hostAllowlist: new Set(['example.com']),
      resolveIP: async () => '1.2.3.4',          // initial validation: public
      // The actual private flip happens inside the dispatcher's connect callback;
      // test seam: simulate by injecting a dispatcher that fakes private resolution.
      _testConnectResolvedIp: '10.0.0.1',
    } as unknown as Parameters<typeof webFetch>[0]);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reasonCode).toBe('web_fetch_ssrf_postresolve_block');
    }
  });
});

describe('web-fetch — UA propagation', () => {
  it('sends mma-research user-agent header', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    let ua = '';
    agent.get('https://example.com')
      .intercept({ path: '/' })
      .reply((opts) => {
        ua = (opts.headers as Record<string,string>)['user-agent']!;
        return { statusCode: 200, headers: { 'content-type': 'text/html' }, data: '<html></html>' };
      });
    const r = await webFetch({
      url: 'https://example.com/',
      cfg,
      hostAllowlist: new Set(['example.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,   // let MockAgent intercept
    });
    await agent.close();
    expect(ua).toMatch(/^mma-research\//);
    expect(r.status).toBe('ok');
  });
});

describe.skipIf(process.env.RUN_INTEGRATION_FETCH !== '1')(
  'web-fetch — real-network smoke (A8)', () => {
    it('fetches https://example.com/ successfully', async () => {
      const r = await webFetch({
        url: 'https://example.com/',
        cfg,
        hostAllowlist: new Set(['example.com']),
      });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.bytesReturned).toBeGreaterThan(0);
      }
    });
  }
);
