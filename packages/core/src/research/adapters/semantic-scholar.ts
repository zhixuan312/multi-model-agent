import { request } from 'undici';
import type { AdapterResult } from './types.js';

export interface SSOpts { maxResults?: number; }

interface SSRRecord {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  year?: unknown;
  url?: unknown;
}

function normalizeRecord(r: SSRRecord): AdapterResult | null {
  const paperId = typeof r.paperId === 'string' && r.paperId.length > 0 ? r.paperId : null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!paperId || !title) return null;

  const abstract = typeof r.abstract === 'string' ? r.abstract : '';
  const apiUrl = typeof r.url === 'string' && r.url.length > 0 ? r.url : null;
  const year = typeof r.year === 'number' && Number.isFinite(r.year) && r.year > 1900 ? r.year : null;

  return {
    adapterId: 'semantic_scholar' as const,
    recordId: paperId,
    title,
    url: apiUrl ?? `https://www.semanticscholar.org/paper/${paperId}`,
    snippet: abstract.slice(0, 500),
    publishedAt: year ? `${year}-01-01` : undefined,
    raw: r,
  };
}

export async function semanticScholarSearch(query: string, opts: SSOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(max));
  url.searchParams.set('fields', 'paperId,title,abstract,year,authors,url');

  let res;
  try {
    res = await request(url.toString(), { method: 'GET', maxRedirections: 0 });
  } catch (err) {
    throw new Error(`semantic_scholar_request_failed: ${(err as Error).message}`);
  }

  if (res.statusCode === 429) throw new Error('semantic_scholar_rate_limited');
  if (res.statusCode >= 300 && res.statusCode < 400) throw new Error('adapter_unexpected_redirect: semantic_scholar');
  if (res.statusCode !== 200) throw new Error(`semantic_scholar_http_${res.statusCode}`);

  let body: unknown;
  try {
    body = await res.body.json();
  } catch (err) {
    throw new Error(`semantic_scholar_parse_error: ${(err as Error).message}`);
  }

  const data = Array.isArray((body as Record<string, unknown>)?.data)
    ? (body as Record<string, unknown>).data as SSRRecord[]
    : [];

  return data
    .slice(0, max)
    .map(normalizeRecord)
    .filter((r): r is AdapterResult => r !== null);
}
