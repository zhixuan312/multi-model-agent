import { describe, it, expect } from 'vitest';
import { compileDelegatePrompt } from '../../packages/core/src/intake/brief-compiler-slots/delegate.js';

describe('delegate prompt content (4.2.3 slim)', () => {
  it('opens with the smallest-complete-change orientation', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp(x,min,max)' });
    expect(out).toContain('SMALLEST COMPLETE CHANGE');
    expect(out).toContain('minimal AND complete');
  });

  it('includes the slim 4-failure-mode taxonomy', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    // 4.2.3 slim — top 4 modes calibrated from observed reviewer rejections.
    expect(out).toContain('SCOPE CREEP');
    expect(out).toContain('SILENT PARTIAL FIX');
    expect(out).toContain('PHANTOM TEST PASS');
    expect(out).toContain('INCOMPLETE REFACTOR');
  });

  it('includes the brief-vs-diff walk', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    expect(out).toContain('Brief-vs-diff walk');
    expect(out).toContain('"Smallest" means no extras. "Complete" means no gaps');
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
    const orientationIdx = out.indexOf('SMALLEST COMPLETE CHANGE');
    const briefIdx = out.indexOf('add util.clamp(x,min,max) to src/util.ts');
    const scopeIdx = out.indexOf('Scope:');
    expect(orientationIdx).toBeLessThan(briefIdx);
    expect(briefIdx).toBeLessThan(scopeIdx);
  });

  it('is significantly slimmer than the pre-4.2.3 prompt (under 6 KB)', () => {
    const out = compileDelegatePrompt({ prompt: 'add util.clamp' });
    // Pre-4.2.3 framing was ~9 KB. Slim target: ~3 KB framing.
    const bytes = Buffer.byteLength(out, 'utf8');
    expect(bytes).toBeLessThan(6 * 1024);
  });
});
