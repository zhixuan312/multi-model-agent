import { describe, expect, it } from 'vitest';
import { rssAdapter } from '../../../packages/core/src/research/adapters/generic-rss.js';
import { readFileSync } from 'node:fs';

const xml = readFileSync('tests/research/fixtures/adapters/example-feed.xml', 'utf8');

describe('rssAdapter', () => {
  it('parses RSS items from rawText (NOT wrapped body)', async () => {
    const fakeFetch = async () => ({
      status: 'ok' as const,
      body: '<external-content url="https://example.com/feed" host="example.com" trustLevel="untrusted">[escaped xml]</external-content>',
      rawText: xml,
      host: 'example.com',
      bytesReturned: xml.length,
      truncated: false,
      textTruncated: false,
      credentialsStripped: false,
    });
    const r = await rssAdapter('https://example.com/feed', { webFetch: fakeFetch });
    expect(r.length).toBe(3);
    expect(r[0].adapterId).toBe('rss');
    expect(r[0].title).toBe('First Article');
    expect(r[0].url).toBe('https://example.com/articles/1');
    expect(r[0].snippet).toBe('This is the first article description with some inline HTML tags.');
    expect(r[0].publishedAt).toBe('Mon, 01 Jan 2024 12:00:00 GMT');
    expect(r[0].raw).toBeTruthy();
  });

  it('rejects URL whose host is not in the per-task allowlist', async () => {
    const fakeFetch = async () => ({
      status: 'error' as const,
      reasonCode: 'web_fetch_off_allowlist',
      credentialsStripped: false,
    });
    await expect(rssAdapter('https://blocked.com/feed', { webFetch: fakeFetch }))
      .rejects.toThrow(/web_fetch_off_allowlist/);
  });

  it('rejects when textTruncated is true', async () => {
    const fakeFetch = async () => ({
      status: 'ok' as const,
      body: '',
      rawText: xml,
      host: 'example.com',
      bytesReturned: xml.length,
      truncated: false,
      textTruncated: true,
      credentialsStripped: false,
    });
    await expect(rssAdapter('https://example.com/feed', { webFetch: fakeFetch }))
      .rejects.toThrow(/rss_text_truncated_skip/);
  });

  it('respects maxResults option', async () => {
    const fakeFetch = async () => ({
      status: 'ok' as const,
      body: '',
      rawText: xml,
      host: 'example.com',
      bytesReturned: xml.length,
      truncated: false,
      textTruncated: false,
      credentialsStripped: false,
    });
    const r = await rssAdapter('https://example.com/feed', { webFetch: fakeFetch, maxResults: 2 });
    expect(r.length).toBe(2);
  });
});
