export type AdapterId = 'arxiv' | 'semantic_scholar' | 'github_search' | 'rss';

export interface AdapterResult {
  adapterId: AdapterId;
  recordId: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;            // ISO 8601 if known
  raw: unknown;                    // adapter-specific payload, opaque to callers
}

export interface AdapterCallContext {
  abortSignal: AbortSignal;
  // populated by ssrf-guard / web-fetch when the adapter goes through web_fetch
  hostAllowlist?: ReadonlySet<string>;
}
