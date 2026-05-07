import { describe, it, expect } from 'vitest';
import { ScratchpadSalvager } from '../../packages/core/src/providers/scratchpad-salvager.js';
import { TextScratchpad } from '../../packages/core/src/providers/text-scratchpad.js';

describe('ScratchpadSalvager', () => {
  const salvager = new ScratchpadSalvager();

  it('returns latest text when scratchpad has content', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'first turn text');
    sp.append(1, 'second turn final answer');

    const result = salvager.salvage({ scratchpad: sp, reason: 'max_turns_exhausted' });

    expect(result.output).toBe('second turn final answer');
    expect(result.source).toBe('latest');
    expect(result.empty).toBe(false);
    expect(result.diagnostic).toContain('reason=max_turns_exhausted');
    expect(result.diagnostic).toContain('salvageSource=latest');
  });

  it('falls back to longest when latest is empty but longest exists', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'a longer text from turn zero');

    const result = salvager.salvage({ scratchpad: sp, reason: 'aborted' });

    expect(result.output).toBe('a longer text from turn zero');
    expect(result.source).toBe('latest');
    expect(result.empty).toBe(false);
  });

  it('returns diagnostic when scratchpad is empty', () => {
    const sp = new TextScratchpad();

    const result = salvager.salvage({
      scratchpad: sp,
      reason: 'error',
      provider: 'openai',
      model: 'gpt-4o',
      turnsUsed: 3,
    });

    expect(result.empty).toBe(true);
    expect(result.source).toBe('diagnostic');
    expect(result.output).toContain('reason=error');
    expect(result.output).toContain('provider=openai');
    expect(result.output).toContain('model=gpt-4o');
    expect(result.output).toContain('turns=3');
    expect(result.output).toContain('salvageSource=diagnostic');
  });

  it('chooses longest over latest when both exist and latest is longer', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'short');
    sp.append(1, 'the longest content across all turns');

    const result = salvager.salvage({ scratchpad: sp, reason: 'timeout' });

    expect(result.output).toBe('the longest content across all turns');
    expect(result.source).toBe('latest');
  });

  it('includes provider and model in diagnostic when given', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'some output');

    const result = salvager.salvage({
      scratchpad: sp,
      reason: 'max_turns',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      turnsUsed: 5,
    });

    expect(result.output).toBe('some output');
    expect(result.diagnostic).toContain('provider=anthropic');
    expect(result.diagnostic).toContain('model=claude-sonnet-4-6');
    expect(result.diagnostic).toContain('turns=5');
  });

  it('latest is the most recent buffered emission', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'very long text from turn zero that should be the longest');
    sp.append(1, 'turn one');
    sp.append(2, 'turn two final');

    const result = salvager.salvage({ scratchpad: sp, reason: 'done' });

    expect(result.output).toBe('turn two final');
  });
});
