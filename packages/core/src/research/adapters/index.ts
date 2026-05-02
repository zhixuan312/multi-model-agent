import type { ResearchConfig } from '../../config/schema.js';
import type { AdapterId } from './types.js';

export function resolveEnabledAdapters(cfg: ResearchConfig['builtinAdapters']): AdapterId[] {
  const out: AdapterId[] = [];
  if (cfg.arxiv) out.push('arxiv');
  if (cfg.semanticScholar) out.push('semantic_scholar');
  if (cfg.githubSearch) out.push('github_search');
  if (cfg.genericRss) out.push('rss');
  return out;
}

export { arxivSearch } from './arxiv.js';
export { semanticScholarSearch } from './semantic-scholar.js';
export { githubSearch } from './github-search.js';
export { rssAdapter } from './generic-rss.js';
