import { describe, it, expect } from 'vitest';
import {
  pathEscapesCwd,
  bashWritesOutsideCwd,
  evaluateConfinement,
} from '../../packages/core/src/providers/claude-cwd-confinement.js';

const CWD = '/work/repo/.mma/worktrees/abcd1234';

describe('pathEscapesCwd', () => {
  it('allows paths inside cwd (absolute + relative)', () => {
    expect(pathEscapesCwd(`${CWD}/src/x.ts`, CWD)).toBe(false);
    expect(pathEscapesCwd('src/x.ts', CWD)).toBe(false);
    expect(pathEscapesCwd('./README.md', CWD)).toBe(false);
    expect(pathEscapesCwd(CWD, CWD)).toBe(false);
  });
  it('flags paths outside cwd', () => {
    expect(pathEscapesCwd('/work/repo/other.ts', CWD)).toBe(true);
    expect(pathEscapesCwd('/Users/me/Documents/code/mma-parent/x.ts', CWD)).toBe(true);
    expect(pathEscapesCwd('../../escape.ts', CWD)).toBe(true);
    expect(pathEscapesCwd('../sibling/x.ts', CWD)).toBe(true);
  });
});

describe('bashWritesOutsideCwd', () => {
  it('returns null for reads + system tools + in-cwd writes', () => {
    expect(bashWritesOutsideCwd('cat /etc/hosts', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('ls /Users/me/other/repo', CWD)).toBeNull(); // read of another repo is fine (codex allows)
    expect(bashWritesOutsideCwd('npm test', CWD)).toBeNull();
    expect(bashWritesOutsideCwd(`echo hi > ${CWD}/out.txt`, CWD)).toBeNull();
    expect(bashWritesOutsideCwd('git status', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('rm -rf node_modules', CWD)).toBeNull(); // relative, in cwd
  });
  it('flags writes targeting an out-of-cwd absolute path', () => {
    expect(bashWritesOutsideCwd('echo x > /Users/me/Documents/code/mma-parent/f.ts', CWD)).toContain('/Users/me/Documents/code/mma-parent');
    expect(bashWritesOutsideCwd('rm -rf /Users/me/other/repo/.git', CWD)).toContain('/Users/me/other/repo');
    expect(bashWritesOutsideCwd('mv a.txt /work/repo/elsewhere/a.txt', CWD)).toContain('/work/repo/elsewhere');
  });
  it('does not flag system-path writes (tmp, /dev/null)', () => {
    expect(bashWritesOutsideCwd('echo x > /dev/null', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('cp a /tmp/b', CWD)).toBeNull();
  });
});

describe('evaluateConfinement', () => {
  it('denies Write/Edit outside cwd, allows inside', () => {
    expect(evaluateConfinement('Edit', { file_path: '/Users/me/code/mma-parent/x.ts' }, CWD).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateConfinement('Write', { file_path: `${CWD}/new.ts` }, CWD).hookSpecificOutput).toBeUndefined();
    expect(evaluateConfinement('NotebookEdit', { notebook_path: '/other/nb.ipynb' }, CWD).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('never restricts reads (Read/Glob/Grep) even outside cwd', () => {
    expect(evaluateConfinement('Read', { file_path: '/Users/me/code/mma-parent/x.ts' }, CWD).hookSpecificOutput).toBeUndefined();
    expect(evaluateConfinement('Glob', { path: '/Users/me/code/mma-parent' }, CWD).hookSpecificOutput).toBeUndefined();
    expect(evaluateConfinement('Grep', { path: '/anywhere' }, CWD).hookSpecificOutput).toBeUndefined();
  });
  it('denies Bash that writes outside cwd, allows in-cwd + reads', () => {
    expect(evaluateConfinement('Bash', { command: 'rm -rf /Users/me/code/mma-parent/.git' }, CWD).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateConfinement('Bash', { command: 'cd /Users/me/code && ls' }, CWD).hookSpecificOutput).toBeUndefined(); // read-only recon
    expect(evaluateConfinement('Bash', { command: 'npm run build' }, CWD).hookSpecificOutput).toBeUndefined();
  });
});
