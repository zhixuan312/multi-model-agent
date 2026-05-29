import { describe, it, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { normalizeOutputTargets } from '../../packages/core/src/lifecycle/normalize-output-targets.js';

// OS-native root + path building (normalizeOutputTargets uses node:path resolve;
// on Windows that yields backslash drive paths). See scope-match.test.ts.
const PROJECT = resolve('/project');

describe('normalizeOutputTargets', () => {
  it('returns empty array when omitted or empty', () => {
    expect(normalizeOutputTargets(undefined, PROJECT)).toEqual([]);
    expect(normalizeOutputTargets([], PROJECT)).toEqual([]);
  });

  it('normalizes relative paths against cwd', () => {
    expect(normalizeOutputTargets(['src/a.ts'], PROJECT)).toEqual([join(PROJECT, 'src/a.ts')]);
  });

  it('accepts absolute paths under cwd', () => {
    expect(normalizeOutputTargets([join(PROJECT, 'src/a.ts')], PROJECT)).toEqual([join(PROJECT, 'src/a.ts')]);
  });

  it('throws when a path escapes cwd', () => {
    expect(() => normalizeOutputTargets(['../outside.ts'], PROJECT)).toThrow(/escapes cwd/);
  });
});
