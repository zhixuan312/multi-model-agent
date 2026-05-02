import { describe, expect, it } from 'vitest';
import { resolveEnabledAdapters } from '../../../packages/core/src/research/adapters/index.js';

describe('resolveEnabledAdapters', () => {
  it('returns all four when all enabled', () => {
    const ids = resolveEnabledAdapters({ arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true });
    expect(ids).toEqual(['arxiv', 'semantic_scholar', 'github_search', 'rss']);
  });
  it('omits disabled adapters', () => {
    const ids = resolveEnabledAdapters({ arxiv: false, semanticScholar: true, githubSearch: true, genericRss: false });
    expect(ids).toEqual(['semantic_scholar', 'github_search']);
  });
});
