import { describe, expect, it } from 'vitest';
import type { AdapterResult, AdapterId } from '../../../packages/core/src/research/adapters/types.js';

describe('AdapterResult shape', () => {
  it('accepts a fully-populated result', () => {
    const r: AdapterResult = {
      adapterId: 'arxiv',
      recordId: '2401.12345',
      title: 'Regime-aware factor timing',
      url: 'https://arxiv.org/abs/2401.12345',
      snippet: 'We show that …',
      publishedAt: '2024-01-15',
      raw: { /* opaque */ },
    };
    expect(r.adapterId).toBe('arxiv');
  });

  it('AdapterId is a string-literal union', () => {
    const ids: AdapterId[] = ['arxiv', 'semantic_scholar', 'github_search', 'openalex', 'crossref', 'pubmed'];
    expect(ids.length).toBe(6);
  });
});
