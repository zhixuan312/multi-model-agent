import { request } from 'undici';
import { USER_AGENT } from './user-agent.js';
import type { ResearchConfig } from '../config/schema.js';

export interface BraveSearchOptions {
  freshness?:     string;
  endpoint?:      'web' | 'news';
  extraSnippets?: boolean;
}
export interface BraveSearchResult {
  title: string;
  url: string;
  snippet: string;
  pageAge?: string;
  extraSnippets?: string[];
}
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
    const extraSnippets = Array.isArray(item.extra_snippets)
      ? (item.extra_snippets as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;
    return {
      title: typeof item.title === 'string' ? item.title : `[missing title ${i}]`,
      url: typeof item.url === 'string' ? item.url : '',
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      pageAge: typeof item.page_age === 'string' ? item.page_age : undefined,
      extraSnippets: extraSnippets && extraSnippets.length > 0 ? extraSnippets : undefined,
    };
  });
}

export class BraveClient {
  private nextKeyIndex = 0;
  // Wall-clock of the last request dispatched on each key (by index), used to
  // enforce minPerKeyIntervalMs. Brave's free tier is 1 req/s/token; the
  // orchestrator fans out queries concurrently, so without per-key spacing a
  // round-robin burst hits the same key within milliseconds → 429.
  private lastRequestAt: number[] = [];
  // Promise-chain critical-section lock: each caller waits for its
  // predecessor, then atomically reads+advances nextKeyIndex AND records the
  // key's dispatch time, so concurrent callers serialize through the spacing
  // gate. try/finally is load-bearing — without it an exception in the
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

  // Atomically pick the next round-robin key AND reserve its dispatch slot:
  // returns the key index plus how long the caller must wait so this key's
  // requests stay ≥ minPerKeyIntervalMs apart. The reservation (advancing
  // lastRequestAt to the reserved time) happens inside the lock; the actual
  // wait is done by the caller OUTSIDE the lock, so spacing one key never
  // blocks dispatch on the other keys.
  private async takeKeySlot(): Promise<{ idx: number; waitMs: number }> {
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

      const interval = this.cfg.minPerKeyIntervalMs ?? 0;
      const now = Date.now();
      const last = this.lastRequestAt[idx] ?? 0;
      // Earliest this key may fire again. Reserve it now so a concurrent
      // sibling grabbing the same key next round queues behind this slot.
      const dispatchAt = interval > 0 ? Math.max(now, last + interval) : now;
      this.lastRequestAt[idx] = dispatchAt;
      return { idx, waitMs: Math.max(0, dispatchAt - now) };
    } finally {
      release();
    }
  }

  async search(query: string, options?: BraveSearchOptions): Promise<BraveSearchResponse> {
    if (this.cfg.apiKeys.length === 0) {
      throw new Error('brave_not_configured: no API keys configured');
    }
    const endpoint = options?.endpoint ?? 'web';
    const basePath = endpoint === 'news' ? '/res/v1/news/search' : '/res/v1/web/search';
    const count = endpoint === 'news' ? 50 : 20;

    const url = new URL(`https://api.search.brave.com${basePath}`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    if (options?.freshness) {
      url.searchParams.set('freshness', options.freshness);
    }
    url.searchParams.set('extra_snippets', 'true');

    const maxAttempts = Math.min(this.cfg.apiKeys.length, 4);
    const attempts: BraveSearchResponse['attempts'] = [];
    const deadline = Date.now() + this.cfg.timeoutMs;

    let lastIndex = -1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() > deadline) {
        throw new Error('brave_deadline_exceeded');
      }
      const { idx, waitMs } = await this.takeKeySlot();
      lastIndex = idx;

      // Honor the per-key spacing reservation. Skip the wait if it would blow
      // the deadline — fall through to the deadline check below.
      if (waitMs > 0 && Date.now() + waitMs <= deadline) {
        await this._sleep(waitMs);
      }

      // Re-check deadline after lock acquisition + spacing wait — either may
      // have waited behind a slow predecessor / the 1 req/s gate.
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
