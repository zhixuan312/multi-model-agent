import { describe, expect, it } from 'vitest';
import { redactAdapterUrl } from '../../../packages/core/src/research/adapters/redact-adapter-url.js';

describe('redactAdapterUrl', () => {
  it('redacts api_key parameter', () => {
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&api_key=secret123';
    expect(redactAdapterUrl(url)).toContain('api_key=REDACTED');
    expect(redactAdapterUrl(url)).not.toContain('secret123');
  });

  it('redacts mailto parameter', () => {
    const url = 'https://api.openalex.org/works?search=q&mailto=user%40example.com';
    expect(redactAdapterUrl(url)).toContain('mailto=REDACTED');
    expect(redactAdapterUrl(url)).not.toContain('user%40example.com');
  });

  it('redacts both api_key and mailto when both present', () => {
    const url = 'https://example.com?api_key=k1&mailto=e%40x.com&other=safe';
    const redacted = redactAdapterUrl(url);
    expect(redacted).toContain('api_key=REDACTED');
    expect(redacted).toContain('mailto=REDACTED');
    expect(redacted).toContain('other=safe');
  });

  it('leaves URLs without sensitive params unchanged', () => {
    const url = 'https://api.openalex.org/works?search=stablecoin&per_page=10';
    expect(redactAdapterUrl(url)).toBe(url);
  });

  it('handles malformed URLs via regex fallback', () => {
    const url = 'not-a-url?api_key=secret&other=ok';
    const redacted = redactAdapterUrl(url);
    expect(redacted).toContain('api_key=REDACTED');
    expect(redacted).not.toContain('secret');
  });
});
