import { compileInvestigate } from '../../../packages/core/src/intake/compilers/investigate.js';

describe('compileInvestigate', () => {
  it('produces a single TaskSpec with the right route and tools default', () => {
    const spec = compileInvestigate({ question: 'How does X work?' }, [], [], [], '/cwd');
    expect(spec.route).toBe('investigate_codebase');
    expect(spec.tools).toBe('readonly');
  });

  it('delegates agentType and reviewPolicy to the executor (not hardcoded in compiler)', () => {
    const spec = compileInvestigate({ question: 'q' } as any, [], [], [], '/cwd');
    expect(spec.agentType).toBeUndefined();
    expect(spec.reviewPolicy).toBeUndefined();
  });

  it('honours caller tools=none', () => {
    const spec = compileInvestigate({ question: 'q', tools: 'none' }, [], [], [], '/cwd');
    expect(spec.tools).toBe('none');
  });

  it('embeds the output contract clause in the prompt', () => {
    const spec = compileInvestigate({ question: 'How does X?' }, [], [], [], '/cwd');
    expect(spec.prompt).toContain('narrative investigation report');
    expect(spec.prompt).toContain('Question: How does X?');
  });

  it('emits anchor paths verbatim from relativeFilePathsForPrompt (no compiler-side normalization)', () => {
    const spec = compileInvestigate(
      { question: 'q' },
      [],
      ['/cwd/src/auth'],
      ['src/auth'],
      '/cwd',
    );
    expect(spec.prompt).toContain('- src/auth');
    expect(spec.prompt).not.toContain('- /cwd/src/auth');
  });

  it('emits "." when the relative form is empty (anchor IS the cwd)', () => {
    const spec = compileInvestigate(
      { question: 'q' },
      [],
      ['/cwd'],
      ['.'],
      '/cwd',
    );
    expect(spec.prompt).toContain('- .');
  });

  it('appends a delta suffix when context blocks are provided', () => {
    const spec = compileInvestigate(
      { question: 'q', contextBlockIds: ['ctx-1'] },
      [{ id: 'ctx-1', content: 'PRIOR REPORT BODY' }],
      [],
      [],
      '/cwd',
    );
    expect(spec.prompt).toContain('PRIOR REPORT BODY');
    expect(spec.prompt).toContain('Refine or extend');
  });

  it('replaces filePaths in originalInput with the canonicalized list', () => {
    const spec = compileInvestigate(
      { question: 'q', filePaths: ['./src/auth/'] },
      [],
      ['/cwd/src/auth'],
      ['src/auth'],
      '/cwd',
    );
    expect((spec as any).originalInput.filePaths).toEqual(['/cwd/src/auth']);
  });

  it('passes filePaths to the TaskSpec as absolute canonical paths', () => {
    const spec = compileInvestigate({ question: 'q' }, [], ['/cwd/src/auth'], ['src/auth'], '/cwd');
    expect(spec.filePaths).toEqual(['/cwd/src/auth']);
  });
});
