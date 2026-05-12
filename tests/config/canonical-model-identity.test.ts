import { canonicalIdentity, identityEquals } from '../../packages/core/src/config/canonical-model-identity.js';

describe('canonicalIdentity', () => {
  it('strips embedded credentials from endpoint', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://user:pass@api.example.com/v1', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain('user');
    expect(id.normalizedEndpoint).not.toContain('pass');
  });

  it('strips default :443 port', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com:443/v1', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain(':443');
  });

  it('strips trailing slash from path endpoint', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com/v1/', model: 'gpt-x' });
    expect(id.normalizedEndpoint).toBe('https://api.example.com/v1');
  });

  it('strips trailing slash from root endpoint', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com/', model: 'gpt-x' });
    expect(id.normalizedEndpoint).toBe('https://api.example.com');
  });

  it('lowercases host', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://API.Example.COM/v1', model: 'gpt-x' });
    expect(id.normalizedEndpoint).toBe('https://api.example.com/v1');
  });

  it('strips query strings', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com/v1?key=secret', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain('secret');
    expect(id.normalizedEndpoint).not.toContain('?');
  });

  it('strips hash fragments', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com/v1#section', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain('#');
    expect(id.normalizedEndpoint).toBe('https://api.example.com/v1');
  });

  it('strips default :80 port for http', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'http://api.example.com:80/v1', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain(':80');
  });

  it('lowercases and trims model id', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://api.example.com/v1', model: '  GPT-X ' });
    expect(id.modelId).toBe('gpt-x');
  });

  it('sanitizes malformed endpoint with credentials and query in fallback', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'api.example.com/v1?key=secret', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain('secret');
    expect(id.normalizedEndpoint).not.toContain('?');
  });

  it('sanitizes malformed endpoint with credentials in fallback', () => {
    const id = canonicalIdentity({ type: 'codex', baseUrl: 'https://user:pass@api.example.com/v1', model: 'gpt-x' });
    expect(id.normalizedEndpoint).not.toContain('user');
    expect(id.normalizedEndpoint).not.toContain('pass');
  });

  it('identity equality is structural', () => {
    const a = canonicalIdentity({ type: 'codex', baseUrl: 'https://x/v1', model: 'gpt' });
    const b = canonicalIdentity({ type: 'codex', baseUrl: 'https://x/v1/', model: 'gpt' });
    expect(identityEquals(a, b)).toBe(true);
  });

  it('different model yields different identity', () => {
    const a = canonicalIdentity({ type: 'codex', baseUrl: 'https://x/v1', model: 'gpt' });
    const b = canonicalIdentity({ type: 'codex', baseUrl: 'https://x/v1', model: 'haiku' });
    expect(identityEquals(a, b)).toBe(false);
  });

  it('codex and claude built-in providers (no baseUrl) get stable identities', () => {
    const a = canonicalIdentity({ type: 'codex', model: 'gpt-5.5' });
    const b = canonicalIdentity({ type: 'codex', model: 'gpt-5.5' });
    expect(identityEquals(a, b)).toBe(true);
  });

  it('handles undefined model gracefully', () => {
    const id = canonicalIdentity({ type: 'codex', model: undefined as unknown as string });
    expect(id.modelId).toBe('');
  });
});
