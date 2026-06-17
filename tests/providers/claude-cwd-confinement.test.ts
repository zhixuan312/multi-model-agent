import { describe, it, expect } from 'vitest';
import {
  pathEscapesCwd,
  bashWritesOutsideCwd,
  evaluateConfinement,
  evaluateReadOnly,
  resolveEffectiveCwd,
  buildConfinementHook,
} from '../../packages/core/src/providers/claude-cwd-confinement.js';

const CWD = '/work/repo/.mma/worktrees/abcd1234';

// ---------------------------------------------------------------------------
// pathEscapesCwd
// ---------------------------------------------------------------------------
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
  it('returns false for empty strings', () => {
    expect(pathEscapesCwd('', CWD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveCwd
// ---------------------------------------------------------------------------
describe('resolveEffectiveCwd', () => {
  it('returns original cwd when no cd is present', () => {
    expect(resolveEffectiveCwd('npm test', CWD)).toBe(CWD);
    expect(resolveEffectiveCwd('ls -la', CWD)).toBe(CWD);
  });
  it('tracks a single cd to an absolute path', () => {
    expect(resolveEffectiveCwd('cd /outside/dir && ls', CWD)).toBe('/outside/dir');
  });
  it('tracks a single cd to a relative path', () => {
    expect(resolveEffectiveCwd('cd src && ls', CWD)).toBe(`${CWD}/src`);
  });
  it('tracks chained cd segments', () => {
    expect(resolveEffectiveCwd('cd /a && cd b && cd c', CWD)).toBe('/a/b/c');
  });
  it('tracks cd after semicolons', () => {
    expect(resolveEffectiveCwd('echo hi; cd /outside; rm file', CWD)).toBe('/outside');
  });
  it('tracks cd with parent references', () => {
    // CWD is /work/repo/.mma/worktrees/abcd1234, ../../escape resolves to /work/repo/.mma/escape
    expect(resolveEffectiveCwd('cd ../../escape && touch x', CWD)).toBe('/work/repo/.mma/escape');
  });
  it('strips quotes from cd target', () => {
    expect(resolveEffectiveCwd("cd '/outside/dir' && ls", CWD)).toBe('/outside/dir');
    expect(resolveEffectiveCwd('cd "/outside/dir" && ls', CWD)).toBe('/outside/dir');
  });
});

// ---------------------------------------------------------------------------
// bashWritesOutsideCwd — original scenarios (preserved)
// ---------------------------------------------------------------------------
describe('bashWritesOutsideCwd', () => {
  it('returns null for reads + system tools + in-cwd writes', () => {
    expect(bashWritesOutsideCwd('cat /etc/hosts', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('ls /Users/me/other/repo', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('npm test', CWD)).toBeNull();
    expect(bashWritesOutsideCwd(`echo hi > ${CWD}/out.txt`, CWD)).toBeNull();
    expect(bashWritesOutsideCwd('git status', CWD)).toBeNull();
    expect(bashWritesOutsideCwd('rm -rf node_modules', CWD)).toBeNull();
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

  // --- NEW: cd chain detection ---
  describe('cd chain detection', () => {
    it('catches cd /outside && <write>', () => {
      expect(bashWritesOutsideCwd('cd /Users/me/other && rm -rf .git', CWD)).not.toBeNull();
    });
    it('catches cd /outside; <write>', () => {
      expect(bashWritesOutsideCwd('cd /Users/me/other; touch exploit.txt', CWD)).not.toBeNull();
    });
    it('catches relative cd that escapes cwd + write', () => {
      expect(bashWritesOutsideCwd('cd ../../.. && mkdir pwned', CWD)).not.toBeNull();
    });
    it('allows cd within cwd + write', () => {
      expect(bashWritesOutsideCwd(`cd ${CWD}/src && touch new.ts`, CWD)).toBeNull();
    });
    it('allows cd to relative subdir + write', () => {
      expect(bashWritesOutsideCwd('cd src && touch new.ts', CWD)).toBeNull();
    });
  });

  // --- NEW: interpreter subshell detection ---
  describe('interpreter subshell detection', () => {
    it('catches python -c with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('python -c "open(\'/Users/me/other/f.txt\',\'w\')"', CWD)).not.toBeNull();
    });
    it('catches node -e with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('node -e "require(\'fs\').writeFileSync(\'/Users/me/other/f.txt\',\'x\')"', CWD)).not.toBeNull();
    });
    it('catches python3 -c with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('python3 -c "open(\'/Users/me/other/f.txt\',\'w\')"', CWD)).not.toBeNull();
    });
    it('catches ruby -e with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('ruby -e "File.write(\'/Users/me/other/f.txt\',\'x\')"', CWD)).not.toBeNull();
    });
    it('catches perl -e with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('perl -e "open(F,\'>\',\'/Users/me/other/f.txt\')"', CWD)).not.toBeNull();
    });
    it('allows interpreter with in-cwd paths', () => {
      expect(bashWritesOutsideCwd(`python -c "open('${CWD}/f.txt','w')"`, CWD)).toBeNull();
    });
    it('allows interpreter without paths', () => {
      expect(bashWritesOutsideCwd('python -c "print(1+1)"', CWD)).toBeNull();
    });
    it('allows interpreter with system paths', () => {
      expect(bashWritesOutsideCwd('python -c "import json; print(json.load(open(\'/etc/hosts\')))"', CWD)).toBeNull();
    });
  });

  // --- NEW: download tool detection ---
  describe('download tool detection', () => {
    it('catches curl -o with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('curl -o /Users/me/other/file.tar.gz https://example.com/f', CWD)).not.toBeNull();
    });
    it('catches curl -O with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('curl -O /Users/me/other/file.tar.gz https://example.com/f', CWD)).not.toBeNull();
    });
    it('catches wget -O with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('wget -O /Users/me/other/file.tar.gz https://example.com/f', CWD)).not.toBeNull();
    });
    it('catches wget -P with out-of-cwd path', () => {
      expect(bashWritesOutsideCwd('wget -P /Users/me/other/ https://example.com/f', CWD)).not.toBeNull();
    });
    it('allows curl -o within cwd', () => {
      expect(bashWritesOutsideCwd(`curl -o ${CWD}/file.tar.gz https://example.com/f`, CWD)).toBeNull();
    });
    it('allows wget without output flag', () => {
      expect(bashWritesOutsideCwd('wget https://example.com/f', CWD)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateConfinement (cwd-only mode)
// ---------------------------------------------------------------------------
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
    expect(evaluateConfinement('Bash', { command: 'cd /Users/me/code && ls' }, CWD).hookSpecificOutput).toBeUndefined();
    expect(evaluateConfinement('Bash', { command: 'npm run build' }, CWD).hookSpecificOutput).toBeUndefined();
  });
  it('denies Bash cd-chain escapes', () => {
    expect(evaluateConfinement('Bash', { command: 'cd /Users/me/other && rm -rf .' }, CWD).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('denies interpreter subshell escapes', () => {
    expect(evaluateConfinement('Bash', { command: 'python -c "open(\'/Users/me/other/f\',\'w\')"' }, CWD).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// evaluateReadOnly (read-only mode)
// ---------------------------------------------------------------------------
describe('evaluateReadOnly', () => {
  it('denies all write tools regardless of path', () => {
    expect(evaluateReadOnly('Write', { file_path: `${CWD}/inside.ts` }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Edit', { file_path: `${CWD}/inside.ts` }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('MultiEdit', { file_path: `${CWD}/inside.ts` }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('NotebookEdit', { notebook_path: `${CWD}/inside.ipynb` }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('allows all read tools', () => {
    expect(evaluateReadOnly('Read', { file_path: '/anywhere/outside.ts' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Glob', { path: '/anywhere' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Grep', { path: '/anywhere' }).hookSpecificOutput).toBeUndefined();
  });
  it('denies Bash with mutating commands', () => {
    expect(evaluateReadOnly('Bash', { command: 'rm -rf node_modules' }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Bash', { command: 'touch new.ts' }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Bash', { command: 'echo x > file.txt' }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Bash', { command: 'mkdir -p src/new' }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('denies Bash with interpreter writes', () => {
    expect(evaluateReadOnly('Bash', { command: 'python -c "open(\'f\',\'w\')"' }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'f\',\'x\')"' }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('denies Bash with download tools', () => {
    expect(evaluateReadOnly('Bash', { command: 'curl -o file.tar.gz https://example.com' }).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluateReadOnly('Bash', { command: 'wget -O file.tar.gz https://example.com' }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('allows Bash with read-only commands', () => {
    expect(evaluateReadOnly('Bash', { command: 'cat README.md' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Bash', { command: 'grep -r "TODO" src/' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Bash', { command: 'find . -name "*.ts"' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Bash', { command: 'git log --oneline' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Bash', { command: 'npm test' }).hookSpecificOutput).toBeUndefined();
    expect(evaluateReadOnly('Bash', { command: 'ls -la /Users/me/other/repo' }).hookSpecificOutput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildConfinementHook (unified builder)
// ---------------------------------------------------------------------------
describe('buildConfinementHook', () => {
  it('returns a PreToolUse hook structure', () => {
    const hook = buildConfinementHook('cwd-only', CWD);
    expect(hook.PreToolUse).toBeInstanceOf(Array);
    expect(hook.PreToolUse[0]!.hooks).toBeInstanceOf(Array);
    expect(hook.PreToolUse[0]!.hooks).toHaveLength(1);
  });

  it('cwd-only hook allows writes inside cwd', async () => {
    const hook = buildConfinementHook('cwd-only', CWD);
    const result = await hook.PreToolUse[0]!.hooks[0]!({ tool_name: 'Write', tool_input: { file_path: `${CWD}/x.ts` } });
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('cwd-only hook denies writes outside cwd', async () => {
    const hook = buildConfinementHook('cwd-only', CWD);
    const result = await hook.PreToolUse[0]!.hooks[0]!({ tool_name: 'Write', tool_input: { file_path: '/outside/x.ts' } });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('read-only hook denies all writes even inside cwd', async () => {
    const hook = buildConfinementHook('read-only', CWD);
    const result = await hook.PreToolUse[0]!.hooks[0]!({ tool_name: 'Write', tool_input: { file_path: `${CWD}/x.ts` } });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('read-only hook allows reads', async () => {
    const hook = buildConfinementHook('read-only', CWD);
    const result = await hook.PreToolUse[0]!.hooks[0]!({ tool_name: 'Read', tool_input: { file_path: '/anywhere/x.ts' } });
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
