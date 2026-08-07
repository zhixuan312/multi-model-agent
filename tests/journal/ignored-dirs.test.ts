import { isUnderIgnoredDir } from '../../packages/core/src/journal/adapters/ignored-dirs.js';

describe('isUnderIgnoredDir', () => {
  it('ignores a file inside a top-level ignored directory', () => {
    expect(isUnderIgnoredDir('dist/x.ts')).toBe(true);
  });

  it('ignores a file inside an ignored directory nested below other directories', () => {
    expect(isUnderIgnoredDir('a/node_modules/b.ts')).toBe(true);
  });

  it('does not ignore a directory whose name merely starts with an ignored name', () => {
    expect(isUnderIgnoredDir('mydist/x.ts')).toBe(false);
  });

  it('does not ignore a file whose name merely starts with an ignored name', () => {
    expect(isUnderIgnoredDir('dist.ts')).toBe(false);
  });
});
