import { request } from 'undici';
import type { AdapterResult } from './types.js';

export interface SSOpts { maxResults?: number; }

export async function semanticScholarSearch(query: string, opts: SSOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(max));
  url.searchParams.set('fields', 'paperId,title,abstract,year,authors,url');

  const res = await request(url.toString(), { method: 'GET', maxRedirections: 0 });
  if (res.statusCode === 429) throw new Error('semantic_scholar_rate_limited');
  if (res.statusCode >= 300 && res.statusCode < 400) throw new Error('adapter_unexpected_redirect: semantic_scholar');
  if (res.statusCode !== 200) throw new Error(`semantic_scholar_http_${res.statusCode}`);

  const body = await res.body.json() as { data?: Array<{ paperId: string; title: string; abstract?: string; year?: number; url?: string }> };
  return (body.data ?? []).slice(0, max).map(d => ({
    adapterId: 'semantic_scholar' as const,
    recordId: d.paperId,
    title: d.title,
    url: d.url ?? `https://www.semanticscholar.org/paper/${d.paperId}`,
    snippet: (d.abstract ?? '').slice(0, 500),
    publishedAt: d.year ? `${d.year}-01-01` : undefined,
    raw: d,
  }));
}
