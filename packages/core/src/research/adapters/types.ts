export type AdapterId = 'arxiv' | 'semantic_scholar' | 'github_search'
                      | 'openalex' | 'crossref' | 'pubmed';

export interface AdapterResult {
  adapterId: AdapterId;
  recordId: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;            // ISO 8601 if known
  raw: unknown;                    // adapter-specific payload, opaque to callers
}

/**
 * Per-request wall-clock timeout shared by the HTTP-fetching adapters.
 *
 * "Shared" means every one of them: each opens an `AbortController`, aborts it after this many
 * milliseconds, and passes the signal to `undici`. Three adapters once omitted it while this
 * comment claimed otherwise, and the orchestrator's `withTimeout` masked the result — it races the
 * promise, so the caller saw a tidy timeout while the socket stayed open. `timeout-parity.test.ts`
 * now asserts every adapter passes a signal.
 */
export const RESEARCH_HTTP_TIMEOUT_MS = 15_000;
