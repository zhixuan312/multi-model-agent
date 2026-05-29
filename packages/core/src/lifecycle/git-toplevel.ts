import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

export interface ResolveOptions {
  timeoutMs?: number;
}

/**
 * Returns the canonical absolute path of the git toplevel for `cwd`, or
 * null if `cwd` is not in a git repo, git is unavailable, the directory
 * does not exist, or the spawn times out (default 5 s).
 *
 * Pure function of (cwd, filesystem state). Never throws.
 */
export async function resolveGitToplevel(
  cwd: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // windowsHide: suppress the console window Windows opens per spawned
        // console binary when the daemon has no attached console. No-op on POSIX.
        windowsHide: true,
      });
    } catch {
      settle(null);
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', () => { /* swallow */ });
    child.on('error', () => settle(null));
    child.on('exit', (code) => {
      // `git --show-toplevel` emits forward-slash paths even on Windows;
      // normalize to an OS-native absolute path so callers comparing against
      // realpath/process.cwd() (backslashes on win32) match.
      if (code === 0) { const out = stdout.trim(); settle(out ? resolvePath(out) : null); }
      else settle(null);
    });
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(null);
    }, timeoutMs);
    child.on('exit', () => clearTimeout(t));
  });
}
