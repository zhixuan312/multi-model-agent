import { request } from 'undici';
import { USER_AGENT } from '../user-agent.js';
import type { AdapterResult } from './types.js';
import { RESEARCH_HTTP_TIMEOUT_MS } from './redact-adapter-url.js';

export interface CrossrefOpts { maxResults?: number; contactEmail?: string; }

function parseDateParts(dateParts: unknown): string | undefined {
  if (!Array.isArray(dateParts) || dateParts.length === 0) return undefined;
  const parts = dateParts[0];
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const year = parts[0];
  if (typeof year !== 'number' || year < 1900) return undefined;
  const month = typeof parts[1] === 'number' ? String(parts[1]).padStart(2, '0') : '01';
  const day = typeof parts[2] === 'number' ? String(parts[2]).padStart(2, '0') : '01';
  return `${year}-${month}-${day}`;
}

export async function crossrefSearch(query: string, opts: CrossrefOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(max));
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
      throw new Error(`crossref_timeout: request exceeded ${RESEARCH_HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.statusCode >= 300 && res.statusCode < 400) {
    throw new Error('adapter_unexpected_redirect: crossref');
  }
  if (res.statusCode !== 200) {
    throw new Error(`crossref_http_${res.statusCode}`);
  }

  let body: unknown;
  try {
    body = await res.body.json();
  } catch (err) {
    throw new Error(`crossref_parse_error: ${(err as Error).message}`);
  }

  const items = Array.isArray((body as any)?.message?.items) ? (body as any).message.items : [];
  return items.slice(0, max).map((r: any) => {
    const doi = typeof r.DOI === 'string' ? r.DOI : '';
    const titles = Array.isArray(r.title) ? r.title : [];
    const title = typeof titles[0] === 'string' ? titles[0].trim() : '';
    if (!title || !doi) return null;

    const abstract = typeof r.abstract === 'string' ? r.abstract : '';
    const subtitles = Array.isArray(r.subtitle) ? r.subtitle : [];
    const subtitle = typeof subtitles[0] === 'string' ? subtitles[0] : '';
    const snippet = (abstract || subtitle).slice(0, 500);

    const publishedAt = parseDateParts(r['published-print']?.['date-parts'])
                     ?? parseDateParts(r['created']?.['date-parts']);

    return {
      adapterId: 'crossref' as const,
      recordId: doi,
      title,
      url: `https://doi.org/${doi}`,
      snippet,
      publishedAt,
      raw: r,
    };
  }).filter((r: AdapterResult | null): r is AdapterResult => r !== null);
}
