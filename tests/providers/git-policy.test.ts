import { describe, it, expect } from 'vitest';
import { evaluateGitArgv, gitDenialInCommand, pathTouchesGitDir } from '../../packages/core/src/providers/git-policy.js';
import { evaluateConfinement, evaluateReadOnly } from '../../packages/core/src/providers/claude-cwd-confinement.js';

/**
 * FR-7 — worker git is DEFAULT-DENY on both subcommands and flags.
 *
 * Under worktrees the caller's real `.git` sat outside the worker's writable subtree, so a
 * misbehaving worker could only damage a directory we were about to delete. Running in place puts
 * the real `.git` inside that subtree.
 *
 * Two separate holes are closed here, and they need separate coverage:
 *   1. subcommand choice — `git reset --hard` must never run;
 *   2. option grammar — an ALLOWED subcommand can still execute an arbitrary program via
 *      `-c core.pager=…`, or via a flag like `--show-signature` that invokes an already-configured
 *      `gpg.program` without itself naming anything.
 */

const allow = (argv: string[]) => expect(evaluateGitArgv(argv).allowed, argv.join(' ')).toBe(true);
const denyArgv = (argv: string[]) => expect(evaluateGitArgv(argv).allowed, argv.join(' ')).toBe(false);

describe('git-policy: allowed read-only usage', () => {
  it('permits the four read-only subcommands', () => {
    allow(['status']);
    allow(['log']);
    allow(['diff']);
    allow(['show']);
  });

  it('permits safe flags and pathspecs', () => {
    allow(['status', '--porcelain']);
    allow(['log', '--oneline', '-n', '5']);
    allow(['log', '--max-count=5', '--format=%H']);
    allow(['diff', '--cached', '--name-only']);
    allow(['diff', '--', 'src/a.ts']);
    allow(['-C', '/some/repo', 'status', '--short']);
  });
});

describe('git-policy: subcommand default-deny', () => {
  it('denies every mutating subcommand', () => {
    for (const sub of [
      'commit', 'checkout', 'reset', 'rebase', 'merge', 'branch', 'push', 'stash',
      'clean', 'tag', 'worktree', 'config', 'apply', 'am', 'cherry-pick', 'revert',
      'filter-branch', 'gc', 'reflog', 'update-ref', 'symbolic-ref', 'remote', 'switch', 'restore',
    ]) denyArgv([sub]);
  });

  it('denies a subcommand that appears in NO list — proving allow-list, not deny-list', () => {
    denyArgv(['bisect']);
    denyArgv(['some-future-subcommand-nobody-has-invented']);
  });

  it('denies bare `git` with no subcommand', () => {
    denyArgv([]);
  });
});

describe('git-policy: option-grammar default-deny (code execution)', () => {
  it('denies config injection even on an allowed subcommand', () => {
    denyArgv(['-c', 'core.pager=sh -c "id"', 'log']);
    denyArgv(['-c', 'diff.external=/bin/sh', 'diff']);
    denyArgv(['--config-env=core.pager=EVIL', 'log']);
  });

  it('denies flags that redirect git to another binary', () => {
    denyArgv(['--exec-path=/tmp', 'status']);
    denyArgv(['--upload-pack=/tmp/x', 'log']);
    denyArgv(['--git-dir=/other/.git', 'status']);
    denyArgv(['--work-tree=/other', 'status']);
  });

  it('denies flags that invoke an ALREADY-CONFIGURED external program', () => {
    // The subtle class: neither sets config nor names a program, yet executes gpg.program.
    denyArgv(['log', '--show-signature']);
    denyArgv(['diff', '--ext-diff']);
    denyArgv(['diff', '--textconv']);
  });

  it('denies an unrecognized flag on an allowed subcommand', () => {
    denyArgv(['log', '--some-future-flag']);
    denyArgv(['status', '--output=/tmp/x']);
  });
});

describe('gitDenialInCommand: shell-level scanning', () => {
  it('returns null for commands with no git', () => {
    expect(gitDenialInCommand('ls -la')).toBeNull();
    expect(gitDenialInCommand('npm test')).toBeNull();
  });

  it('allows read-only git in a shell command', () => {
    expect(gitDenialInCommand('git status --porcelain')).toBeNull();
    expect(gitDenialInCommand('git log --oneline -n 3')).toBeNull();
  });

  it('catches a denied git anywhere in a chain', () => {
    expect(gitDenialInCommand('npm test && git reset --hard')).toBeTruthy();
    expect(gitDenialInCommand('git status; git checkout master')).toBeTruthy();
    expect(gitDenialInCommand('echo hi | git commit -m x')).toBeTruthy();
  });

  it('is not fooled by env prefixes, absolute paths, or -C', () => {
    expect(gitDenialInCommand('GIT_DIR=/x git reset --hard')).toBeTruthy();
    expect(gitDenialInCommand('/usr/bin/git reset --hard')).toBeTruthy();
    expect(gitDenialInCommand('git -C /repo push origin main')).toBeTruthy();
  });

  /**
   * The subcommand and flag grammars above are genuinely default-deny. The SCANNER that
   * decides which token runs is what let five ordinary shell idioms past all of it: the
   * segment splitter knew only chain operators, so it read `echo $(git reset --hard)` as one
   * `echo` command and never looked inside.
   *
   * These are not evasion techniques. `for f in $(git ls-files)` is how a worker naturally
   * writes a loop, and a worker that reaches for `bash -c` is usually quoting, not hiding. A
   * policy whose header says "a subcommand nobody has thought of is denied, not allowed by
   * omission" cannot be turned off by a pair of parentheses.
   */
  it('looks inside command substitutions and backticks', () => {
    expect(gitDenialInCommand('echo $(git reset --hard)')).toBeTruthy();
    expect(gitDenialInCommand('`git clean -fd`')).toBeTruthy();
    expect(gitDenialInCommand('for f in $(git ls-files); do echo $f; done')).toBeTruthy();
    // Nested, and with the denial not in the outermost level.
    expect(gitDenialInCommand('echo "$(printf %s "$(git checkout .)")"')).toBeTruthy();
    // A read-only git in a substitution is still fine — this closes a hole, it does not
    // forbid the idiom.
    expect(gitDenialInCommand('echo $(git log --oneline -n 1)')).toBeNull();
    expect(gitDenialInCommand('for f in $(git diff --name-only); do echo $f; done')).toBeNull();
  });

  it('looks inside a shell interpreter invoked with -c', () => {
    expect(gitDenialInCommand('bash -c "git reset --hard"')).toBeTruthy();
    expect(gitDenialInCommand("sh -c 'git checkout .'")).toBeTruthy();
    expect(gitDenialInCommand('zsh -lc "git push origin main"')).toBeTruthy();
    expect(gitDenialInCommand('bash -c "git status --porcelain"')).toBeNull();
  });

  it('sees through wrapper commands that take the git invocation as their argument', () => {
    expect(gitDenialInCommand('xargs git reset --hard')).toBeTruthy();
    expect(gitDenialInCommand('timeout 5 git clean -fd')).toBeTruthy();
    expect(gitDenialInCommand('nohup git push &')).toBeTruthy();
    expect(gitDenialInCommand('timeout 5 git status')).toBeNull();
  });

  it('does not deny prose that merely mentions git', () => {
    // The scanner resolves a COMMAND position, not any occurrence of the word — otherwise
    // explaining the rule would trip it.
    expect(gitDenialInCommand('echo "do not run git reset --hard"')).toBeNull();
    expect(gitDenialInCommand('grep -r "git push" docs/')).toBeNull();
  });
});

describe('pathTouchesGitDir', () => {
  it('flags .git paths', () => {
    expect(pathTouchesGitDir('.git')).toBe(true);
    expect(pathTouchesGitDir('.git/config')).toBe(true);
    expect(pathTouchesGitDir('sub/.git/HEAD')).toBe(true);
  });

  it('does not flag ordinary paths', () => {
    expect(pathTouchesGitDir('src/index.ts')).toBe(false);
    expect(pathTouchesGitDir('.gitignore')).toBe(false);
    expect(pathTouchesGitDir('docs/gitlab.md')).toBe(false);
  });
});

/** Both sandbox policies must reach the SAME decision — the policy is shared, not duplicated. */
describe('claude confinement enforces the shared git policy', () => {
  const CWD = '/work/repo';
  const denied = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';

  it('denies mutating git under cwd-only', () => {
    expect(denied(evaluateConfinement('Bash', { command: 'git reset --hard' }, CWD))).toBe(true);
    expect(denied(evaluateConfinement('Bash', { command: 'git commit -m x' }, CWD))).toBe(true);
    expect(denied(evaluateConfinement('Bash', { command: 'git clean -fdx' }, CWD))).toBe(true);
  });

  it('still allows read-only git under cwd-only', () => {
    expect(denied(evaluateConfinement('Bash', { command: 'git status' }, CWD))).toBe(false);
    expect(denied(evaluateConfinement('Bash', { command: 'git log --oneline' }, CWD))).toBe(false);
  });

  it('denies writes into .git even though the path is inside cwd', () => {
    expect(denied(evaluateConfinement('Write', { file_path: '.git/config' }, CWD))).toBe(true);
    expect(denied(evaluateConfinement('Write', { file_path: 'src/ok.ts' }, CWD))).toBe(false);
  });

  it('applies the same git policy to read-only tasks', () => {
    expect(denied(evaluateReadOnly('Bash', { command: 'git reset --hard' }))).toBe(true);
    expect(denied(evaluateReadOnly('Bash', { command: 'git status' }))).toBe(false);
  });
});
