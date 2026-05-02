import { request } from 'undici';
import type { ResearchConfig } from '../config/schema.js';

export interface BraveSearchResult { title: string; url: string; snippet: string; }
export interface BraveSearchResponse {
  results: BraveSearchResult[];
  keyIndex: number;
  attempts: Array<{ keyIndex: number; status: number | 'error' }>;
}

export class BraveClient {
  private nextKeyIndex = 0;
  private lockChain: Promise<void> = Promise.resolve();
  constructor(private readonly cfg: ResearchConfig['brave']) {}

  private async takeNextKeyIndex(): Promise<number> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.lockChain;
    this.lockChain = next;
    try {
      await prev;
      const n = this.cfg.apiKeys.length;
      if (n === 0) {
        throw new Error('brave_internal_no_keys');
      }
      const idx = this.nextKeyIndex;
      this.nextKeyIndex = (this.nextKeyIndex + 1) % n;
      return idx;
    } finally {
      release();
    }
  }

  async search(query: string, siteFilter?: string): Promise<BraveSearchResponse> {
    if (this.cfg.apiKeys.length === 0) {
      throw new Error('brave_not_configured: no API keys configured');
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', siteFilter ? `${siteFilter} ${query}` : query);
    url.searchParams.set('count', String(this.cfg.maxResultsPerQuery));

    const maxAttempts = Math.min(this.cfg.apiKeys.length, 4);
    const attempts: BraveSearchResponse['attempts'] = [];
    const deadline = Date.now() + this.cfg.timeoutMs;

    let lastIndex = -1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() > deadline) {
        throw new Error('brave_deadline_exceeded');
      }
      const idx = await this.takeNextKeyIndex();
      lastIndex = idx;
      const key = this.cfg.apiKeys[idx]!;
      const ctrl = new AbortController();
      const remaining = Math.max(50, deadline - Date.now());
      const timer = setTimeout(() => ctrl.abort(), remaining);
      let res: Awaited<ReturnType<typeof request>> | undefined;
      try {
        res = await request(url.toString(), {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'x-subscription-token': key,
          },
          signal: ctrl.signal,
        });
        if (res.statusCode === 200) {
          const body = await res.body.json() as { web?: { results?: BraveSearchResult[] } };
          return {
            results: (body.web?.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
            keyIndex: idx,
            attempts: [...attempts, { keyIndex: idx, status: 200 }],
          };
        }
        attempts.push({ keyIndex: idx, status: res.statusCode });
      } catch {
        attempts.push({ keyIndex: idx, status: 'error' });
      } finally {
        clearTimeout(timer);
        if (res && res.statusCode !== 200) {
          try { await res.body.dump?.(); } catch { /* nothing */ }
        }
      }
      const base = this.cfg.perCallBackoffMs * (2 ** attempt);
      const jitter = base * (0.75 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, jitter));
    }
    const summary = attempts.map(a => a.status).join(',');
    throw new Error(`brave_keys_exhausted: attempts=[${summary}] lastKeyIndex=${lastIndex}`);
  }
}
