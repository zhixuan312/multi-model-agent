import { describe, it, expect } from 'vitest';
import { normalizeOutputTargets } from '../../packages/core/src/lifecycle/normalize-output-targets.js';

describe('normalizeOutputTargets', () => {
  it('returns empty array when omitted or empty', () => {
    expect(normalizeOutputTargets(undefined, '/project')).toEqual([]);
    expect(normalizeOutputTargets([], '/project')).toEqual([]);
  });

  it('normalizes relative paths against cwd', () => {
    expect(normalizeOutputTargets(['src/a.ts'], '/project')).toEqual(['/project/src/a.ts']);
  });

  it('accepts absolute paths under cwd', () => {
    expect(normalizeOutputTargets(['/project/src/a.ts'], '/project')).toEqual(['/project/src/a.ts']);
  });

  it('throws when a path escapes cwd', () => {
    expect(() => normalizeOutputTargets(['../outside.ts'], '/project')).toThrow(/escapes cwd/);
  });
});
