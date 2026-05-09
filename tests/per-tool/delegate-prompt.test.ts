import { describe, it, expect } from 'vitest';
import { compileDelegatePrompt } from '../../packages/core/src/intake/brief-compiler-slots/delegate.js';

describe('delegate prompt content', () => {
  it('opens with the smallest-complete-change orientation block', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp(x,min,max)' });
    expect(out).toContain('Why this delegation exists');
    expect(out).toContain('SMALLEST COMPLETE CHANGE');
    expect(out).toContain('minimal AND complete simultaneously');
  });

  it('includes the delegate failure-mode taxonomy', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    // All 9 categories.
    expect(out).toContain('SCOPE CREEP');
    expect(out).toContain('SILENT PARTIAL FIX');
    expect(out).toContain('WRONG FILE TARGET');
    expect(out).toContain('PHANTOM TEST PASS');
    expect(out).toContain('CROSS-CUTTING DAMAGE');
    expect(out).toContain('CONVENTION DRIFT');
    expect(out).toContain('INCOMPLETE REFACTOR');
    expect(out).toContain('SPEC OVERREACH');
    expect(out).toContain('UNDOCUMENTED ASSUMPTION');
  });

  it('includes the brief-vs-diff walk with worked example', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    expect(out).toContain('Brief-vs-diff walk');
    expect(out).toContain('Worked example');
    expect(out).toContain('paginate');
  });

  it('strengthens the file constraint when filePaths is set', () => {
    const out = compileDelegatePrompt({
      prompt: 'add util.clamp',
      filePaths: ['src/util.ts', 'tests/util.test.ts'],
    });
    expect(out).toContain('FILE CONSTRAINT: write to exactly these path(s)');
    expect(out).toContain('Existing files in this list are pre-verified');
    expect(out).toContain('Non-existent paths in this list are explicit OUTPUT TARGETS');
    expect(out).toContain('off-limits to write');
    expect(out).toContain('`src/util.ts`');
    expect(out).toContain('`tests/util.test.ts`');
  });

  it('omits the file constraint when filePaths is empty', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    expect(out).not.toContain('FILE CONSTRAINT');
  });

  it('embeds the caller brief between the orientation and the rules', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp(x,min,max) to src/util.ts' });
    expect(out).toContain('Brief from the caller');
    expect(out).toContain('add util.clamp(x,min,max) to src/util.ts');
    // Brief should appear after the orientation but before the failure-modes block.
    // The failure-modes block opens with a unique sentinel ("Patterns to
    // consciously check for. Apply on EVERY delegated task:") — using the
    // bare phrase "SCOPE CREEP" would pick up the earlier mention inside
    // the orientation block.
    const orientationIdx = out.indexOf('Why this delegation exists');
    const briefIdx = out.indexOf('add util.clamp(x,min,max) to src/util.ts');
    const failureBlockIdx = out.indexOf('Patterns to consciously check for. Apply on EVERY delegated task');
    expect(orientationIdx).toBeLessThan(briefIdx);
    expect(briefIdx).toBeLessThan(failureBlockIdx);
  });
});
