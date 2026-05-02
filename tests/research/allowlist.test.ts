import { describe, expect, it } from 'vitest';
import { buildHostAllowlist, extractURLHosts } from '../../packages/core/src/research/allowlist.js';

describe('extractURLHosts', () => {
  it('extracts and IDNA-normalizes URL hosts from text', () => {
    const hosts = extractURLHosts([
      'See https://example.com/path and HTTPS://EXAMPLE.com again',
      'Also https://examplé.com here',
    ]);
    expect(hosts).toEqual(['example.com', 'xn--exampl-gva.com']);
  });

  it('skips bare hostnames without scheme', () => {
    expect(extractURLHosts(['just example.com mentioned'])).toEqual([]);
  });

  it('skips IP-literal URLs', () => {
    expect(extractURLHosts(['https://127.0.0.1/x', 'https://[::1]/'])).toEqual([]);
  });

  it('skips malformed URLs silently', () => {
    expect(extractURLHosts(['https://', 'https://no-tld'])).toEqual([]);
  });
});

describe('buildHostAllowlist', () => {
  it('combines fetchAllowlistExtra with userSources URL hosts and tracks provenance', () => {
    const map = buildHostAllowlist({
      fetchAllowlistExtra: ['wiki.firm.local'],
      userSources: ['Visit https://example.com/r'],
    });
    expect(map.get('example.com')).toBe('user_source');
    expect(map.get('wiki.firm.local')).toBe('extra');
    expect(map.size).toBe(2);
  });

  it('fetchAllowlistExtra wins on collision (provenance is "extra")', () => {
    const map = buildHostAllowlist({
      fetchAllowlistExtra: ['example.com'],
      userSources: ['https://example.com/page'],
    });
    expect(map.get('example.com')).toBe('extra');
    expect(map.size).toBe(1);
  });

  it('does NOT include builtin adapter hosts (least-privilege)', () => {
    const map = buildHostAllowlist({ fetchAllowlistExtra: [], userSources: [] });
    expect(map.has('arxiv.org')).toBe(false);
    expect(map.has('api.github.com')).toBe(false);
  });

  it('matches with exact equality, never substring', () => {
    const map = buildHostAllowlist({ fetchAllowlistExtra: ['example.com'], userSources: [] });
    expect(map.has('example.com')).toBe(true);
    expect(map.has('evil-example.com')).toBe(false);
    expect(map.has('a.example.com')).toBe(false);
  });
});
