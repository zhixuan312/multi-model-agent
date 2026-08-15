import { request } from 'undici';
import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT } from '../user-agent.js';
import { RESEARCH_HTTP_TIMEOUT_MS, type AdapterResult } from './types.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export interface ArxivOpts { maxResults?: number; }

export async function arxivSearch(query: string, opts: ArxivOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));
  // arxiv's query parser rejects punctuation in `all:` (`?`, `:`, parens, etc.)
  // with HTTP 400 even after URL-encoding — a raw natural-language question
  // would 400. Reduce to arxiv-safe tokens (alphanumerics/-, single-spaced,
  // length-capped); fall back to the raw query only if sanitizing emptied it.
  const safe = query.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${safe || query}`);
  url.searchParams.set('max_results', String(max));

  // `RESEARCH_HTTP_TIMEOUT_MS` with a real AbortController, matching openalex/crossref/pubmed.
  // The orchestrator's `withTimeout` is a promise race: it rejects the CALLER after
  // `perAdapterTimeoutMs` and does nothing to the request, so without this an unresponsive
  // endpoint held an undici socket open for the daemon's lifetime while the orchestrator had
  // long since moved on.
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
    if ((err as Error).name === 'AbortError' || (err as { code?: string }).code === 'UND_ERR_ABORTED') {
      throw new Error(`arxiv_timeout: request exceeded ${RESEARCH_HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  clearTimeout(timer);
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
