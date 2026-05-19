import { request } from 'undici';
import { USER_AGENT } from './user-agent.js';
import type { ResearchConfig } from '../config/schema.js';

export interface BraveSearchResult { title: string; url: string; snippet: string; }
export interface BraveSearchResponse {
  results: BraveSearchResult[];
  keyIndex: number;
  attempts: Array<{ keyIndex: number; status: number | 'error' }>;
}

function validateBraveResults(body: unknown): BraveSearchResult[] {
  if (body == null || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const web = b.web;
  if (web == null || typeof web !== 'object') return [];
  const results = (web as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.map((r: unknown, i: number) => {
    if (r == null || typeof r !== 'object') {
      return { title: `[invalid entry ${i}]`, url: '', snippet: '' };
    }
    const item = r as Record<string, unknown>;
    return {
      title: typeof item.title === 'string' ? item.title : `[missing title ${i}]`,
      url: typeof item.url === 'string' ? item.url : '',
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
    };
  });
}

export class BraveClient {
  private nextKeyIndex = 0;
  // Promise-chain critical-section lock: each caller waits for its
  // predecessor, then atomically reads+advances nextKeyIndex.
  // try/finally is load-bearing — without it an exception in the
  // critical section would stall the chain permanently, hanging every
  // subsequent search() call.
  private lockChain: Promise<void> = Promise.resolve();

  // Injectable for deterministic testing (backoff/jitter).
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _random: () => number;

  constructor(
    private readonly cfg: ResearchConfig['brave'],
    opts?: { sleep?: (ms: number) => Promise<void>; random?: () => number },
  ) {
    this._sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._random = opts?.random ?? (() => Math.random());
  }

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

      // Re-check deadline after lock acquisition — takeNextKeyIndex() may
      // have waited behind a slow predecessor.
      if (Date.now() > deadline) {
        throw new Error('brave_deadline_exceeded');
      }

      const key = this.cfg.apiKeys[idx]!;
      const ctrl = new AbortController();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('brave_deadline_exceeded');
      }
      const timer = setTimeout(() => ctrl.abort(), remaining);
      let res: Awaited<ReturnType<typeof request>> | undefined;
      try {
        res = await request(url.toString(), {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'user-agent': USER_AGENT,
            'x-subscription-token': key,
          },
          signal: ctrl.signal,
        });
        if (res.statusCode === 200) {
          const body = await res.body.json() as unknown;
          return {
            results: validateBraveResults(body),
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

      // No sleep after the final attempt.
      if (attempt < maxAttempts - 1) {
        const base = this.cfg.perCallBackoffMs * (2 ** attempt);
        const jitter = base * (0.75 + this._random() * 0.5);
        // Cap to remaining deadline so backoff alone never exceeds timeoutMs.
        const capped = Math.min(jitter, Math.max(0, deadline - Date.now()));
        await this._sleep(capped);
      }
    }
    const summary = attempts.map(a => a.status).join(',');
    throw new Error(`brave_keys_exhausted: attempts=[${summary}] lastKeyIndex=${lastIndex}`);
  }
}
