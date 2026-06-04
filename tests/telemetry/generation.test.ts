import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGeneration, bumpGeneration } from '../../packages/server/src/telemetry/generation.js';

describe('generation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-gen-')); });

  it('readGeneration returns 0 when file is absent', () => {
    expect(readGeneration(dir)).toBe(0);
  });

  it('bumpGeneration creates the file at 1, then 2, then 3', async () => {
    expect(await bumpGeneration(dir)).toBe(1);
    expect(readGeneration(dir)).toBe(1);
    expect(await bumpGeneration(dir)).toBe(2);
    expect(await bumpGeneration(dir)).toBe(3);
  });

  it('parallel bumpGeneration calls produce strictly increasing values, no duplicates', async () => {
    const results = await Promise.all([1,2,3,4,5,6,7,8,9,10].map(() => bumpGeneration(dir)));
    expect(new Set(results).size).toBe(results.length);   // all distinct
    expect(Math.max(...results)).toBe(results.length);    // last value equals count
  });
});
