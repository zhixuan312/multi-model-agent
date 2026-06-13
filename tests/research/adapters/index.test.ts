import { describe, expect, it } from 'vitest';
import { resolveEnabledAdapters } from '../../../packages/core/src/research/adapters/index.js';

const baseCfg = {
  arxiv: true, semanticScholar: true, githubSearch: true,
  openalex: true, crossref: true, pubmed: true,
};

describe('resolveEnabledAdapters', () => {
  it('returns all six when every flag is true and the SS key is present', () => {
    expect(resolveEnabledAdapters(baseCfg, {
      semanticScholarApiKey: 'sk-test',
    })).toEqual(
      ['arxiv', 'semantic_scholar', 'github_search', 'openalex', 'crossref', 'pubmed']
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

  it('enables openalex, crossref, pubmed by default', () => {
    const out = resolveEnabledAdapters(baseCfg);
    expect(out).toContain('openalex');
    expect(out).toContain('crossref');
    expect(out).toContain('pubmed');
  });

  it('disables openalex when config says false', () => {
    const cfg = { ...baseCfg, openalex: false };
    const enabled = resolveEnabledAdapters(cfg);
    expect(enabled).not.toContain('openalex');
    expect(enabled).toContain('crossref');
    expect(enabled).toContain('pubmed');
  });

  it('disables crossref independently', () => {
    const cfg = { ...baseCfg, crossref: false };
    const enabled = resolveEnabledAdapters(cfg);
    expect(enabled).not.toContain('crossref');
    expect(enabled).toContain('openalex');
  });

  it('disables pubmed independently', () => {
    const cfg = { ...baseCfg, pubmed: false };
    const enabled = resolveEnabledAdapters(cfg);
    expect(enabled).not.toContain('pubmed');
  });
});
