export type AdapterId = 'arxiv' | 'semantic_scholar' | 'github_search';

export interface AdapterResult {
  adapterId: AdapterId;
  recordId: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;            // ISO 8601 if known
  raw: unknown;                    // adapter-specific payload, opaque to callers
}
