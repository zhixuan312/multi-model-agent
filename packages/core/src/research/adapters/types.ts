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

/** Per-request wall-clock timeout shared by the HTTP-fetching adapters. */
export const RESEARCH_HTTP_TIMEOUT_MS = 15_000;
