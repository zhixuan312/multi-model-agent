import { describe, it, expect } from 'vitest';
import { ResearchAdapterEnum } from '../../packages/core/src/events/event-base.js';

describe('ResearchAdapterEnum', () => {
  it('matches the 6 canonical adapter ids defined in enums.md §11', () => {
    expect(ResearchAdapterEnum.options).toEqual([
      'arxiv',
      'semantic_scholar',
      'github_search',
      'rss',
      'web_search',
      'web_fetch',
    ]);
  });
  it('accepts every spec adapter id', () => {
    for (const v of ['arxiv', 'semantic_scholar', 'github_search', 'rss', 'web_search', 'web_fetch'] as const) {
      expect(() => ResearchAdapterEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects unknown adapter ids', () => {
    expect(() => ResearchAdapterEnum.parse('google')).toThrow();
  });
});
