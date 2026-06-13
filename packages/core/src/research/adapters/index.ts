import type { ResearchConfig } from '../../config/schema.js';
import type { AdapterId } from './types.js';

export interface AdapterCredentials {
  semanticScholarApiKey?: string;
  githubPat?: string;
}

export function resolveEnabledAdapters(
  cfg: ResearchConfig['builtinAdapters'],
  creds: AdapterCredentials = {},
): AdapterId[] {
  const out: AdapterId[] = [];
  if (cfg.arxiv) out.push('arxiv');
  if (cfg.semanticScholar) {
    if (creds.semanticScholarApiKey && creds.semanticScholarApiKey.length > 0) {
      out.push('semantic_scholar');
    }
  }
  if (cfg.githubSearch) out.push('github_search');
  if (cfg.openalex) out.push('openalex');
  if (cfg.crossref) out.push('crossref');
  if (cfg.pubmed) out.push('pubmed');
  return out;
}

export { arxivSearch } from './arxiv.js';
export { semanticScholarSearch } from './semantic-scholar.js';
export { githubSearch } from './github-search.js';
export { openalexSearch } from './openalex.js';
export { crossrefSearch } from './crossref.js';
export { pubmedSearch } from './pubmed.js';
export { redactAdapterUrl, RESEARCH_HTTP_TIMEOUT_MS } from './redact-adapter-url.js';
