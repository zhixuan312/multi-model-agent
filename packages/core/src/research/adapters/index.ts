import type { ResearchConfig } from '../../config/schema.js';
import type { AdapterId } from './types.js';

export interface AdapterCredentials {
  semanticScholarApiKey?: string;
  githubPat?: string;
}

/**
 * The adapters whose absence from `resolveEnabledAdapters` means a MISSING CREDENTIAL rather than
 * an operator switching them off. Only `semantic_scholar` is credential-gated below: the rest are
 * keyless (arXiv, OpenAlex, Crossref) or take an OPTIONAL token that only raises rate limits
 * (GitHub, PubMed), so they appear whenever their config flag is true.
 *
 * Read by the orchestrator so a skipped adapter reports why it was skipped. It used to report
 * `no_api_key_configured` for every skip, which sent an operator who had deliberately set
 * `builtinAdapters.crossref: false` looking for a Crossref API key that does not exist.
 */
export const CREDENTIAL_GATED_ADAPTERS: ReadonlySet<AdapterId> = new Set<AdapterId>(['semantic_scholar']);

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
export { RESEARCH_HTTP_TIMEOUT_MS } from './types.js';
