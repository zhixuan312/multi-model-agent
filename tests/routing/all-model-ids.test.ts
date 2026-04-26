import { describe, it, expect } from 'vitest';
import { ALL_MODEL_IDS } from '../../packages/core/src/routing/model-profiles.js';

describe('ALL_MODEL_IDS', () => {
  it('is non-empty in production-shaped builds', () => {
    expect(ALL_MODEL_IDS.length).toBeGreaterThan(0);
  });
  it('contains canonical model-id prefixes (e.g. claude-opus-4-1, deepseek-v4-pro)', () => {
    // Each entry is a `prefix` string from packages/core/src/model-profiles.json,
    // matched case-sensitively at lookup time by `findModelProfile()`.
    expect(ALL_MODEL_IDS).toEqual(expect.arrayContaining(['claude-opus-4-1', 'deepseek-v4-pro']));
  });
  it('every entry is a non-empty string', () => {
    for (const id of ALL_MODEL_IDS) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
