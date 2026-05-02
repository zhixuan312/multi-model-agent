import { XMLParser } from 'fast-xml-parser';
import type { AdapterResult } from './types.js';
import type { WebFetchResult } from '../web-fetch.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export interface RssOpts {
  webFetch: (url: string) => Promise<WebFetchResult>;
  maxResults?: number;
}

export async function rssAdapter(url: string, opts: RssOpts): Promise<AdapterResult[]> {
  const r = await opts.webFetch(url);
  if (r.status !== 'ok') throw new Error(`rss_fetch_failed:${r.reasonCode}`);
  if (r.textTruncated) throw new Error('rss_text_truncated_skip');
  const parsed = parser.parse(r.rawText) as any;
  const rdfItems = parsed?.['rdf:RDF']?.item ?? parsed?.RDF?.item;
  const items = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? rdfItems ?? [];
  const arr = Array.isArray(items) ? items : [items];
  const max = Math.min(50, Math.max(1, opts.maxResults ?? 25));
  return arr.slice(0, max).map((it: any) => ({
    adapterId: 'rss' as const,
    recordId: String(
      it.guid?.['#text'] ?? it.guid ??
      it['rdf:about'] ?? it['@_rdf:about'] ??
      it.link ?? it.title
    ),
    title: String(it.title?.['#text'] ?? it.title ?? '').trim(),
    url: String(it.link?.['@_href'] ?? it.link ?? ''),
    snippet: String(it.description?.['#text'] ?? it.description ?? it.summary ?? '').replace(/<[^>]+>/g, '').slice(0, 500),
    publishedAt: String(it.pubDate ?? it.published ?? it['dc:date'] ?? ''),
    raw: it,
  }));
}
