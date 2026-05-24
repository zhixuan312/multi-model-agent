import { resolveEnabledAdapters } from '../../../packages/core/src/research/adapters/index.js';

const baseCfg = {
  arxiv: true, semanticScholar: true, githubSearch: true,
};

describe('resolveEnabledAdapters', () => {
  it('returns all three when every flag is true and the SS key is present', () => {
    expect(resolveEnabledAdapters(baseCfg, {
      semanticScholarApiKey: 'sk-test',
    })).toEqual(
      ['arxiv', 'semantic_scholar', 'github_search']
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
