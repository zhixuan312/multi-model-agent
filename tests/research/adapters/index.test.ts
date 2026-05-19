import { resolveEnabledAdapters } from '../../../packages/core/src/research/adapters/index.js';

const baseCfg = {
  arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true,
};

describe('resolveEnabledAdapters', () => {
  it('returns all four when every flag is true and no key gate', () => {
    expect(resolveEnabledAdapters(baseCfg, {
      semanticScholarApiKey: 'sk-test',
    })).toEqual(
      ['arxiv', 'semantic_scholar', 'github_search', 'rss']
    );
  });

  it('skips semantic_scholar when enabled but no apiKey provided', () => {
    const out = resolveEnabledAdapters(baseCfg, {
      semanticScholarApiKey: undefined,
    });
    expect(out).not.toContain('semantic_scholar');
  });

  it('includes semantic_scholar when apiKey is provided', () => {
    const out = resolveEnabledAdapters(baseCfg, {
      semanticScholarApiKey: 'sk-test',
    });
    expect(out).toContain('semantic_scholar');
  });

  it('always includes github_search (positive-path PAT is per-call, not per-adapter)', () => {
    const out = resolveEnabledAdapters(baseCfg, { githubPat: undefined });
    expect(out).toContain('github_search');
  });
});
