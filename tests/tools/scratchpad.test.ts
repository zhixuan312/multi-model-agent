import { describe, it, expect } from 'vitest';
import { TextScratchpad } from '../../packages/core/src/tools/scratchpad.js';

describe('TextScratchpad', () => {
  it('starts empty', () => {
    const sp = new TextScratchpad();
    expect(sp.isEmpty()).toBe(true);
    expect(sp.toString()).toBe('');
    expect(sp.latest()).toBe('');
    expect(sp.longest()).toBe('');
  });
});

describe('TextScratchpad — append behavior', () => {
  it('ignores empty and whitespace-only emissions', () => {
    const sp = new TextScratchpad();
    sp.append(0, '');
    sp.append(1, '   ');
    sp.append(2, '\n\t');
    expect(sp.isEmpty()).toBe(true);
  });

  it('records non-empty emissions in turn order', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'first');
    sp.append(1, 'second');
    sp.append(2, 'third');
    expect(sp.toString()).toBe('first\n\n---\n\nsecond\n\n---\n\nthird');
  });

  it('latest() returns the most recently appended emission', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'first');
    sp.append(1, 'second');
    expect(sp.latest()).toBe('second');
  });

  it('longest() returns the longest emission regardless of order', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'short');
    sp.append(1, 'this is the longest emission of all three');
    sp.append(2, 'medium length');
    expect(sp.longest()).toBe('this is the longest emission of all three');
  });

  it('reset() clears all buffered emissions', () => {
    const sp = new TextScratchpad();
    sp.append(0, 'something');
    sp.reset();
    expect(sp.isEmpty()).toBe(true);
    expect(sp.toString()).toBe('');
  });
});
