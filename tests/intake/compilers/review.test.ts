import { describe, it, expect } from 'vitest';
import { compileReviewCode } from '../../../packages/core/src/intake/compilers/review.js';

describe('review compiler', () => {
  it('returns single draft for no files and no code/inline', () => {
    const drafts = compileReviewCode({}, 'req');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draftId).toBe('req:0:root');
    expect(drafts[0].source.route).toBe('review_code');
  });

  it('returns single draft for single file without code', () => {
    const drafts = compileReviewCode({ filePaths: ['src/foo.ts'] }, 'req');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draftId).toBe('req:0:src%2Ffoo.ts');
    expect(drafts[0].filePaths).toEqual(['src/foo.ts']);
  });

  it('fans out to N drafts for N files with code/inlineContent', () => {
    const drafts = compileReviewCode({
      filePaths: ['src/a.ts', 'src/b.ts'],
      code: 'const x = 1;',
    }, 'req');
    expect(drafts).toHaveLength(2);
    expect(drafts[0].draftId).toBe('req:0:src%2Fa.ts');
    expect(drafts[1].draftId).toBe('req:1:src%2Fb.ts');
    expect(drafts[0].filePaths).toEqual(['src/a.ts']);
    expect(drafts[1].filePaths).toEqual(['src/b.ts']);
  });

  it('fans out for inlineContent with multiple files', () => {
    const drafts = compileReviewCode({
      filePaths: ['a.ts', 'b.ts'],
      inlineContent: 'some content',
    }, 'req');
    expect(drafts).toHaveLength(2);
  });

  it('includes output contract in prompt', () => {
    const drafts = compileReviewCode({ filePaths: ['src/foo.ts'] }, 'req');
    expect(drafts[0].prompt).toContain('Provide a structured review');
  });
});