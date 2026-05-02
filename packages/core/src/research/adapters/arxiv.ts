import { request } from 'undici';
import { XMLParser } from 'fast-xml-parser';
import type { AdapterResult } from './types.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export interface ArxivOpts { maxResults?: number; }

export async function arxivSearch(query: string, opts: ArxivOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('max_results', String(max));

  const res = await request(url.toString(), { method: 'GET' });
  if (res.statusCode >= 300 && res.statusCode < 400) {
    throw new Error('adapter_unexpected_redirect: arxiv');
  }
  if (res.statusCode !== 200) {
    throw new Error(`arxiv_http_${res.statusCode}`);
  }
  const xml = await res.body.text();
  const parsed = parser.parse(xml) as { feed?: { entry?: unknown } };
  const entriesRaw = parsed.feed?.entry;
  const entries = Array.isArray(entriesRaw) ? entriesRaw : entriesRaw ? [entriesRaw] : [];
  return entries.slice(0, max).map((e: any) => {
    const id = String(e.id ?? '');
    const m = id.match(/(\d{4}\.\d{4,5})(v\d+)?$/);
    const rawUrl = id || String(e.link?.['@_href'] ?? '');
    const url = rawUrl.replace(/^http:\/\//i, 'https://');
    return {
      adapterId: 'arxiv' as const,
      recordId: m?.[1] ?? id,
      title: String(e.title ?? '').trim(),
      url,
      snippet: String(e.summary ?? '').trim().slice(0, 500),
      publishedAt: String(e.published ?? ''),
      raw: e,
    };
  });
}
