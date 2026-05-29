// Cross-platform git helpers for tests.
//
// Tests must NOT shell out via `execSync('git init && ...', { shell: '/bin/bash' })`:
// `/bin/bash` is absent on Windows and on Alpine/musl (busybox `ash`), so those
// runs fail with ENOENT/exit-127. Invoke git directly through execFileSync (no
// shell, argv array) and delete paths with node:fs — both are OS-agnostic.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** Run a single git subcommand in `cwd` with no shell. Returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** `git init` + a committer identity, so `git commit` works in CI sandboxes. */
export function initGitRepo(cwd: string): void {
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 't@t.com');
  git(cwd, 'config', 'user.name', 't');
}

/** Stage the given paths (default: everything) and commit. */
export function commit(cwd: string, message: string, paths: string[] = ['.']): void {
  git(cwd, 'add', ...paths);
  git(cwd, 'commit', '-m', message);
}

/** Remove `<cwd>/.git` to simulate a corrupted / absent repo. */
export function removeGitDir(cwd: string): void {
  rmSync(join(cwd, '.git'), { recursive: true, force: true });
}
