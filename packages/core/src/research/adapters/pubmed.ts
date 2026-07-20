import { request } from 'undici';
import { USER_AGENT } from '../user-agent.js';
import type { AdapterResult } from './types.js';
import { RESEARCH_HTTP_TIMEOUT_MS } from './types.js';

export interface PubMedOpts { maxResults?: number; apiKey?: string; }

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parsePubDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parts = raw.split(/\s+/);
  const year = parts[0];
  if (!year || !/^\d{4}$/.test(year)) return undefined;
  const month = parts[1] ? (MONTHS[parts[1]] ?? '01') : '01';
  const day = parts[2] && /^\d{1,2}$/.test(parts[2]) ? parts[2].padStart(2, '0') : '01';
  return `${year}-${month}-${day}`;
}

async function timedRequest(url: string): Promise<Awaited<ReturnType<typeof request>>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RESEARCH_HTTP_TIMEOUT_MS);
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      signal: ac.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError' || (err as any).code === 'UND_ERR_ABORTED') {
      throw new Error(`pubmed_timeout: request exceeded ${RESEARCH_HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export async function pubmedSearch(query: string, opts: PubMedOpts = {}): Promise<AdapterResult[]> {
  const max = Math.min(25, Math.max(1, opts.maxResults ?? 10));

  const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  searchUrl.searchParams.set('db', 'pubmed');
  searchUrl.searchParams.set('term', query);
  searchUrl.searchParams.set('retmode', 'json');
  searchUrl.searchParams.set('retmax', String(max));
  if (opts.apiKey) searchUrl.searchParams.set('api_key', opts.apiKey);

  const searchRes = await timedRequest(searchUrl.toString());
  if (searchRes.statusCode >= 300 && searchRes.statusCode < 400) {
    throw new Error('adapter_unexpected_redirect: pubmed');
  }
  if (searchRes.statusCode !== 200) {
    throw new Error(`pubmed_http_${searchRes.statusCode}`);
  }

  let searchBody: unknown;
  try {
    searchBody = await searchRes.body.json();
  } catch (err) {
    throw new Error(`pubmed_parse_error: ${(err as Error).message}`);
  }

  const idList = (searchBody as any)?.esearchresult?.idlist;
  if (!Array.isArray(idList) || idList.length === 0) return [];

  const pmids = idList.slice(0, max).map(String).join(',');
  const summaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
  summaryUrl.searchParams.set('db', 'pubmed');
  summaryUrl.searchParams.set('id', pmids);
  summaryUrl.searchParams.set('retmode', 'json');
  if (opts.apiKey) summaryUrl.searchParams.set('api_key', opts.apiKey);

  const summaryRes = await timedRequest(summaryUrl.toString());
  if (summaryRes.statusCode >= 300 && summaryRes.statusCode < 400) {
    throw new Error('adapter_unexpected_redirect: pubmed');
  }
  if (summaryRes.statusCode !== 200) {
    throw new Error(`pubmed_http_${summaryRes.statusCode}`);
  }

  let summaryBody: unknown;
  try {
    summaryBody = await summaryRes.body.json();
  } catch (err) {
    throw new Error(`pubmed_parse_error: ${(err as Error).message}`);
  }

  const result = (summaryBody as any)?.result;
  if (!result || typeof result !== 'object') return [];

  const uids = Array.isArray(result.uids) ? result.uids.map(String) : [];
  return uids.map((uid: string) => {
    const entry = result[uid];
    if (!entry || typeof entry !== 'object') return null;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) return null;
    return {
      adapterId: 'pubmed' as const,
      recordId: uid,
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}`,
      snippet: title,
      publishedAt: parsePubDate(entry.pubdate),
      raw: entry,
    };
  }).filter((r: AdapterResult | null): r is AdapterResult => r !== null);
}
