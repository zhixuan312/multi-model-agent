import { describe, it, expect } from 'vitest';
import { delegateBriefSlot } from '../../../packages/core/src/tools/delegate/brief-slot.js';

// All assertions go through the public slot (compileDelegatePrompt is now
// private inside brief-slot.ts). Each test runs the slot on a one-task input
// and reads the resulting brief's `prompt` field — the compiled worker prompt.

function compile(prompt: string, filePaths?: string[]): string {
  const briefs = delegateBriefSlot({
    tasks: [{
      prompt,
      filePaths,
      agentType: 'standard',
      reviewPolicy: 'full',
    }],
  } as any);
  return briefs[0].prompt;
}

describe('delegateBriefSlot — compiled prompt content (4.2.3 slim)', () => {
  it('opens with the smallest-complete-change orientation', () => {
    const out = compile('add util.clamp(x,min,max)');
    expect(out).toContain('SMALLEST COMPLETE CHANGE');
    expect(out).toContain('minimal AND complete');
  });

  it('includes the slim 4-failure-mode taxonomy', () => {
    const out = compile('add util.clamp');
    expect(out).toContain('SCOPE CREEP');
    expect(out).toContain('SILENT PARTIAL FIX');
    expect(out).toContain('PHANTOM TEST PASS');
    expect(out).toContain('INCOMPLETE REFACTOR');
  });

  it('includes the brief-vs-diff walk', () => {
    const out = compile('add util.clamp');
    expect(out).toContain('Brief-vs-diff walk');
    expect(out).toContain('"Smallest" means no extras. "Complete" means no gaps');
  });

  it('strengthens the file constraint when filePaths is set', () => {
    const out = compile('add util.clamp', ['src/util.ts', 'tests/util.test.ts']);
    expect(out).toContain('FILE CONSTRAINT: write to exactly these path(s)');
    expect(out).toContain('Existing files in this list are pre-verified');
    expect(out).toContain('Non-existent paths in this list are explicit OUTPUT TARGETS');
    expect(out).toContain('off-limits to write');
    expect(out).toContain('`src/util.ts`');
    expect(out).toContain('`tests/util.test.ts`');
  });

  it('omits the file constraint when filePaths is empty', () => {
    const out = compile('add util.clamp');
    expect(out).not.toContain('FILE CONSTRAINT');
  });

  it('embeds the caller brief between the orientation and the rules', () => {
    const out = compile('add util.clamp(x,min,max) to src/util.ts');
    expect(out).toContain('Brief from the caller');
    expect(out).toContain('add util.clamp(x,min,max) to src/util.ts');
    const orientationIdx = out.indexOf('SMALLEST COMPLETE CHANGE');
    const briefIdx = out.indexOf('add util.clamp(x,min,max) to src/util.ts');
    const scopeIdx = out.indexOf('Scope:');
    expect(orientationIdx).toBeLessThan(briefIdx);
    expect(briefIdx).toBeLessThan(scopeIdx);
  });

  it('is significantly slimmer than the pre-4.2.3 prompt (under 6 KB)', () => {
    const out = compile('add util.clamp');
    const bytes = Buffer.byteLength(out, 'utf8');
    expect(bytes).toBeLessThan(6 * 1024);
  });
});

describe('delegateBriefSlot — brief construction', () => {
  it('returns one brief per task', () => {
    const briefs = delegateBriefSlot({
      tasks: [
        { prompt: 'a', agentType: 'standard', reviewPolicy: 'full' },
        { prompt: 'b', agentType: 'complex', reviewPolicy: 'none' },
      ],
    } as any);
    expect(briefs).toHaveLength(2);
  });

  it('defaults agentType and reviewPolicy', () => {
    const briefs = delegateBriefSlot({
      tasks: [{ prompt: 'x' }],
    } as any);
    expect(briefs[0].agentType).toBe('standard');
    expect(briefs[0].reviewPolicy).toBe('full');
  });

  it('forwards contextBlockIds onto the brief', () => {
    const briefs = delegateBriefSlot({
      tasks: [{
        prompt: 'x',
        contextBlockIds: ['cb-1'],
        agentType: 'standard',
        reviewPolicy: 'full',
      }],
    } as any);
    expect(briefs[0].contextBlockIds).toEqual(['cb-1']);
  });
});
