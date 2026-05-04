import { describe, it, expect } from 'vitest';
import { BriefCompiler } from '../../packages/core/src/intake-pipeline/brief-compiler.js';

describe('BriefCompiler framework', () => {
  it('delegates to slot filler', () => {
    const c = new BriefCompiler<{ x: number }, { brief: string }>(
      (input) => ({ brief: `value=${input.x}` }),
    );
    expect(c.compile({ x: 42 })).toEqual({ brief: 'value=42' });
  });
});
