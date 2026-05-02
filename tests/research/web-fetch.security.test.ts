import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { defaultIPPinningDispatcher, webFetch } from '../../packages/core/src/research/web-fetch.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

const cfg = ResearchConfigSchema.parse({}).fetch;
const allowlist = new Set(['example.com', 'redirector.com', 'private.example.com']);

describe('webFetch — security (SSRF + allowlist)', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  // §7.1 DNS SSRF
  it('rejects DNS resolution to private IP (ssrf-guard integration)', async () => {
    const r = await webFetch({
      url: 'https://example.com/internal',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '10.0.0.1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  it('rejects DNS resolution to loopback IP', async () => {
    const r = await webFetch({
      url: 'https://example.com/loopback',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '127.0.0.1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  it('rejects DNS resolution to link-local / metadata IP', async () => {
    const r = await webFetch({
      url: 'https://example.com/meta',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '169.254.169.254',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  it('rejects DNS resolution to metadata ULA (fd00:ec2::254)', async () => {
    const r = await webFetch({
      url: 'https://example.com/aws-meta',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => 'fd00:ec2::254',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  it('rejects DNS resolution to IPv6 loopback (::1)', async () => {
    const r = await webFetch({
      url: 'https://example.com/v6-loopback',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '::1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  it('allows private IP resolution when host is in privateNetworkHosts', async () => {
    const privateHosts = new Set(['private.example.com']);

    agent
      .get('https://private.example.com')
      .intercept({ path: '/data' })
      .reply(200, 'internal content', { headers: { 'content-type': 'text/plain' } });

    const r = await webFetch({
      url: 'https://private.example.com/data',
      cfg,
      hostAllowlist: allowlist,
      privateNetworkHosts: privateHosts,
      resolveIP: async () => '10.0.0.5',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
  });

  it('still rejects loopback even when host is in privateNetworkHosts', async () => {
    const privateHosts = new Set(['private.example.com']);

    const r = await webFetch({
      url: 'https://private.example.com/loopback',
      cfg,
      hostAllowlist: allowlist,
      privateNetworkHosts: privateHosts,
      resolveIP: async () => '127.0.0.1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_private_ip_blocked');
  });

  // §7.1 step 7 — IP-literal URLs
  it('rejects IPv4 literal URL', async () => {
    const r = await webFetch({
      url: 'https://192.168.1.1/admin',
      cfg,
      hostAllowlist: new Set(['192.168.1.1']),
      resolveIP: async () => '192.168.1.1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_ip_literal_blocked');
  });

  it('rejects IPv6 literal URL (bracketed)', async () => {
    const r = await webFetch({
      url: 'https://[::1]/admin',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '::1',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_ip_literal_blocked');
  });

  // §7.1 step 4 — URL validation
  it('rejects non-HTTPS scheme', async () => {
    const r = await webFetch({
      url: 'http://example.com/page',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '93.184.216.34',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_invalid_scheme');
  });

  it('rejects completely malformed URLs', async () => {
    const r = await webFetch({
      url: '',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_invalid_url');
  });

  it('rejects javascript: scheme parsed as URL', async () => {
    const r = await webFetch({
      url: 'javascript:alert(1)',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_invalid_scheme');
  });

  // Credential stripping (must happen before ANY log/processing)
  it('strips credentials from URL and reports it', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/private' })
      .reply(200, '<html><body><p>secret</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://alice:secret123@example.com/private',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.credentialsStripped).toBe(true);
      expect(r.body).not.toContain('secret123');
      expect(r.body).not.toContain('alice');
    }
  });

  // Error message must not leak internal IPs
  it('error messages do not leak resolved private IPs', async () => {
    const r = await webFetch({
      url: 'https://example.com/internal',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '192.168.1.100',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('192.168.1.100');
  });

  // DNS failure
  it('returns web_fetch_dns_resolution_failed when DNS resolution throws', async () => {
    const r = await webFetch({
      url: 'https://example.com/broken',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => {
        throw new Error('SERVFAIL');
      },
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_dns_resolution_failed');
  });

  // Content-type filtering
  it('rejects application/pdf content type', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/doc.pdf' })
      .reply(200, '%PDF-1.4 binary...',
             { headers: { 'content-type': 'application/pdf' } });

    const r = await webFetch({
      url: 'https://example.com/doc.pdf',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_unsupported_content_type');
  });

  // Large body truncation at wire level
  it('enforces maxBodyBytes at wire level for large payloads', async () => {
    const bigContent = 'x'.repeat(500_000);
    const smallCfg = { ...cfg, maxBodyBytes: 1000 };

    agent
      .get('https://example.com')
      .intercept({ path: '/big-file' })
      .reply(200, bigContent, { headers: { 'content-type': 'text/plain' } });

    const r = await webFetch({
      url: 'https://example.com/big-file',
      cfg: smallCfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.truncated).toBe(true);
      expect(r.bytesReturned).toBeLessThanOrEqual(1200);
      expect(r.rawText.length).toBeLessThanOrEqual(1200);
    }
  });

  // Content-type with charset parameter
  it('strips charset from content-type header', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/utf8' })
      .reply(200, '<html><body><p>UTF-8 content with emoji: 🎉</p></body></html>',
             { headers: { 'content-type': 'text/html; charset=utf-8' } });

    const r = await webFetch({
      url: 'https://example.com/utf8',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
  });

  // Empty response body
  it('handles empty response body gracefully', async () => {
    agent
      .get('https://example.com')
      .intercept({ path: '/empty' })
      .reply(200, '', { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://example.com/empty',
      cfg,
      hostAllowlist: allowlist,
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.bytesReturned).toBe(0);
    }
  });
});

describe('webFetch — security (redirect SSRF)', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  // Redirect to off-allowlist host
  it('rejects redirect to off-allowlist host with redirect-specific code', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/redirect' })
      .reply(302, '', {
        headers: { location: 'https://evil.com/landing' },
      });

    const r = await webFetch({
      url: 'https://safe.com/redirect',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_off_allowlist');
  });

  // Redirect max count enforcement
  it('enforces maxRedirects limit', async () => {
    const smallCfg = { ...cfg, maxRedirects: 1 };

    agent
      .get('https://safe.com')
      .intercept({ path: '/r1' })
      .reply(302, '', {
        headers: { location: 'https://safe.com/r2' },
      });
    agent
      .get('https://safe.com')
      .intercept({ path: '/r2' })
      .reply(302, '', {
        headers: { location: 'https://safe.com/r3' },
      });

    const r = await webFetch({
      url: 'https://safe.com/r1',
      cfg: smallCfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_too_many_redirects');
  });

  // Redirect missing location header
  it('rejects redirect with missing location header', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/bad-redir' })
      .reply(302, '', { headers: {} });

    const r = await webFetch({
      url: 'https://safe.com/bad-redir',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_missing_location');
  });

  // Redirect to IP-literal → maps to redirect-specific code
  it('rejects redirect to IP-literal URL', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/to-ip' })
      .reply(302, '', {
        headers: { location: 'https://127.0.0.1/admin' },
      });

    const r = await webFetch({
      url: 'https://safe.com/to-ip',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_ip_literal_blocked');
  });

  it('rejects malformed redirect Location with structured error', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/bad-location' })
      .reply(302, '', { headers: { location: 'https://[::1' } });

    const r = await webFetch({
      url: 'https://safe.com/bad-location',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_invalid_url');
  });

  it('strips credentials from redirect targets before request and wrapping', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/cred-redir' })
      .reply(302, '', {
        headers: { location: 'https://alice:secret@safe.com/end' },
      });
    agent
      .get('https://safe.com')
      .intercept({ path: '/end' })
      .reply(200, '<html><body><p>credential-free final</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://safe.com/cred-redir',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.credentialsStripped).toBe(true);
      expect(r.body).not.toContain('alice');
      expect(r.body).not.toContain('secret');
      expect(r.rawText).not.toContain('alice');
      expect(r.rawText).not.toContain('secret');
      expect(JSON.stringify(r)).not.toContain('alice:secret');
    }
  });

  // Redirect to HTTP (scheme downgrade detection at redirect)
  it('rejects redirect to HTTP with redirect_scheme_downgrade code', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/downgrade' })
      .reply(302, '', {
        headers: { location: 'http://safe.com/insecure' },
      });

    const r = await webFetch({
      url: 'https://safe.com/downgrade',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_scheme_downgrade');
  });

  // Successful redirect (happy path)
  it('follows a valid redirect and fetches the final URL', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/start' })
      .reply(301, '', {
        headers: { location: 'https://safe.com/end' },
      });
    agent
      .get('https://safe.com')
      .intercept({ path: '/end' })
      .reply(200, '<html><body><p>final page</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://safe.com/start',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('final page');
      expect(r.host).toBe('safe.com');
    }
  });

  // Redirect to private IP — uses counter to return public on first hop, private on second
  it('rejects redirect that resolves to private IP on second hop', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/to-private' })
      .reply(301, '', {
        headers: { location: 'https://other-safe.com/internal' },
      });

    let callCount = 0;
    const r = await webFetch({
      url: 'https://safe.com/to-private',
      cfg,
      hostAllowlist: new Set(['safe.com', 'other-safe.com']),
      resolveIP: async (host: string) => {
        callCount++;
        if (callCount === 1) {
          // First hop: safe.com → public
          expect(host).toBe('safe.com');
          return '8.8.8.8';
        }
        // Second hop: other-safe.com → private IP
        expect(host).toBe('other-safe.com');
        return '10.0.0.1';
      },
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('error');
    expect(r.reasonCode).toBe('web_fetch_redirect_private_ip_blocked');
  });

  // Relative redirect followed by DNS check
  it('follows relative redirect Location and validates target', async () => {
    agent
      .get('https://safe.com')
      .intercept({ path: '/old-path' })
      .reply(301, '', {
        headers: { location: '/new-path' },
      });
    agent
      .get('https://safe.com')
      .intercept({ path: '/new-path' })
      .reply(200, '<html><body><p>arrived</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    const r = await webFetch({
      url: 'https://safe.com/old-path',
      cfg,
      hostAllowlist: new Set(['safe.com']),
      resolveIP: async () => '8.8.8.8',
      createDispatcher: () => undefined,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.body).toContain('arrived');
    }
  });
});

describe('webFetch — default IP-pinning dispatcher', () => {
  it('pins lookup to resolved IP', () => {
    const dispatcher = defaultIPPinningDispatcher('example.com', '1.2.3.4', cfg) as unknown as {
      [key: symbol]: { options?: { connect?: { lookup?: Function } } };
    };
    const state = Object.getOwnPropertySymbols(dispatcher)
      .map((s) => dispatcher[s])
      .find((value) => value?.options?.connect?.lookup);

    state?.options?.connect?.lookup?.('example.com', {}, (err: Error | null, address: string, family: number) => {
      expect(err).toBeNull();
      expect(address).toBe('1.2.3.4');
      expect(family).toBe(4);
    });
    void (dispatcher as unknown as { destroy?: () => void }).destroy?.();
  });

  it('uses custom createDispatcher when provided', async () => {
    // This test verifies the factory is called with correct arguments.
    let capturedHost: string | undefined;
    let capturedIP: string | undefined;

    const customFactory = (host: string, pinnedIP: string, _cfg: typeof cfg) => {
      capturedHost = host;
      capturedIP = pinnedIP;
      return undefined; // fall back to MockAgent
    };

    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    agent
      .get('https://example.com')
      .intercept({ path: '/test' })
      .reply(200, '<html><body><p>ok</p></body></html>',
             { headers: { 'content-type': 'text/html' } });

    await webFetch({
      url: 'https://example.com/test',
      cfg,
      hostAllowlist: new Set(['example.com']),
      resolveIP: async () => '1.2.3.4',
      createDispatcher: customFactory,
    });

    expect(capturedHost).toBe('example.com');
    expect(capturedIP).toBe('1.2.3.4');

    await agent.close();
  });
});
