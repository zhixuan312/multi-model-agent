import { spawn } from 'node:child_process';

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
      if (code === 0) settle(stdout.trim() || null);
      else settle(null);
    });
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(null);
    }, timeoutMs);
    child.on('exit', () => clearTimeout(t));
  });
}
