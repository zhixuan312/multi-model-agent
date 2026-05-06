import { describe, it, expect } from 'vitest';
import { ResearchAdapterEnum } from '../../packages/core/src/events/event-base.js';

describe('ResearchAdapterEnum', () => {
  it('accepts the four current adapter ids', () => {
    for (const v of ['arxiv', 'semantic_scholar', 'github_search', 'rss'] as const) {
      expect(() => ResearchAdapterEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects unknown adapter ids', () => {
    expect(() => ResearchAdapterEnum.parse('google')).toThrow();
  });
});
