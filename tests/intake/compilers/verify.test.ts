import { describe, it, expect } from 'vitest';
import { compileVerifyWork } from '../../../packages/core/src/intake/compilers/verify.js';

describe('verify compiler', () => {
  it('returns single draft for <=1 file', () => {
    const drafts = compileVerifyWork({ checklist: ['check 1'] }, 'req');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source.route).toBe('verify_work');
    expect(drafts[0].prompt).toContain('check 1');
  });

  it('fans out to N drafts for N files', () => {
    const drafts = compileVerifyWork({
      filePaths: ['a.ts', 'b.ts'],
      checklist: ['check'],
    }, 'req');
    expect(drafts).toHaveLength(2);
    expect(drafts[0].draftId).toBe('req:0:a.ts');
    expect(drafts[1].draftId).toBe('req:1:b.ts');
    expect(drafts[0].filePaths).toEqual(['a.ts']);
    expect(drafts[1].filePaths).toEqual(['b.ts']);
  });

  it('includes output contract in prompt', () => {
    const drafts = compileVerifyWork({ checklist: ['check 1'] }, 'req');
    expect(drafts[0].prompt).toContain('pass/fail');
  });
});