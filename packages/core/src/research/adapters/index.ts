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
    // If enabled but no key, silently skip; caller logs warning at startup.
  }
  if (cfg.githubSearch) out.push('github_search');
  if (cfg.genericRss) out.push('rss');
  return out;
}

export { arxivSearch } from './arxiv.js';
export { semanticScholarSearch } from './semantic-scholar.js';
export { githubSearch } from './github-search.js';
export { rssAdapter } from './generic-rss.js';
