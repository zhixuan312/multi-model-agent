import type { SourceRoute, AnySource } from '../../packages/core/src/intake/types.js';

describe('SourceRoute', () => {
  it('includes investigate_codebase', () => {
    const route: SourceRoute = 'investigate_codebase';
    expect(route).toBe('investigate_codebase');
  });

  it('AnySource includes an InvestigateSource variant', () => {
    const src: AnySource = {
      route: 'investigate_codebase',
      originalInput: { question: 'q' },
      question: 'q',
      filePaths: [],
    };
    expect(src.route).toBe('investigate_codebase');
  });
});
