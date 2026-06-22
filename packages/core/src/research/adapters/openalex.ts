import { request } from 'undici';
import { USER_AGENT } from '../user-agent.js';
import type { AdapterResult } from './types.js';
import { RESEARCH_HTTP_TIMEOUT_MS } from './redact-adapter-url.js';

export interface OpenAlexOpts { maxResults?: number; contactEmail?: string; }

function reconstructAbstract(inverted: Record<string, number[]> | null | undefined): string {
  if (!inverted || typeof inverted !== 'object') return '';
  const pairs: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === 'number') pairs.push([word, pos]);
    }
  }
  pairs.sort((a, b) => a[1] - b[1]);
  return pairs.map(p => p[0]).join(' ');
}

export async function openalexSearch(query: string, opts: OpenAlexOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', String(max));
  if (opts.contactEmail) {
    url.searchParams.set('mailto', opts.contactEmail);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RESEARCH_HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await request(url.toString(), {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError' || (err as any).code === 'UND_ERR_ABORTED') {
      throw new Error(`openalex_timeout: request exceeded ${RESEARCH_HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.statusCode >= 300 && res.statusCode < 400) {
    throw new Error('adapter_unexpected_redirect: openalex');
  }
  if (res.statusCode !== 200) {
    throw new Error(`openalex_http_${res.statusCode}`);
  }

  let body: unknown;
  try {
    body = await res.body.json();
  } catch (err) {
    throw new Error(`openalex_parse_error: ${(err as Error).message}`);
  }

  const results = Array.isArray((body as any)?.results) ? (body as any).results : [];
  return results.slice(0, max).map((r: any) => {
    const title = typeof r.display_name === 'string' ? r.display_name.trim() : '';
    const doi = typeof r.doi === 'string' ? r.doi : null;
    const id = typeof r.id === 'string' ? r.id : '';
    const year = typeof r.publication_year === 'number' && r.publication_year > 1900
      ? r.publication_year : null;
    const abstract = reconstructAbstract(r.abstract_inverted_index);
    return {
      adapterId: 'openalex' as const,
      recordId: id,
      title,
      url: doi ?? id,
      snippet: abstract.slice(0, 500),
      publishedAt: year ? `${year}-01-01` : undefined,
      raw: r,
    };
  }).filter((r: AdapterResult) => r.title.length > 0);
}
