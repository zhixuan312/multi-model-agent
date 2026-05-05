import { describe, it, expect } from 'vitest';
import { IntakePipeline } from '../../packages/core/src/intake/intake-pipeline.js';

describe('IntakePipeline', () => {
  it('runs stages in order', () => {
    const p = new IntakePipeline<number, number>([
      { name: 'inc', run: (x: number) => x + 1 },
      { name: 'dbl', run: (x: number) => x * 2 },
    ]);
    expect(p.run(3)).toBe(8);
  });
});
