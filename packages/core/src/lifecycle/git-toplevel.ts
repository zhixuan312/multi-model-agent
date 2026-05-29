import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

export interface ResolveOptions {
  timeoutMs?: number;
  /** Max spawn attempts on a TRANSIENT failure (spawn error / timeout). Default 3. */
  maxAttempts?: number;
}

/** Outcome of one spawn attempt. `transient` = spawn-level failure (EAGAIN/ENOMEM)
 *  or timeout — worth retrying; a clean non-zero exit (not a repo) is definitive. */
interface Attempt { value: string | null; transient: boolean; }

function attemptOnce(cwd: string, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null, transient = false) => {
      if (settled) return;
      settled = true;
      resolve({ value, transient });
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
      settle(null, true); // synchronous spawn throw → transient
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', () => { /* swallow */ });
    // A spawn-level 'error' (EAGAIN/ENOMEM under fork pressure) is transient.
    child.on('error', () => settle(null, true));
    child.on('exit', (code) => {
      // `git --show-toplevel` emits forward-slash paths even on Windows;
      // normalize to an OS-native absolute path so callers comparing against
      // realpath/process.cwd() (backslashes on win32) match.
      if (code === 0) { const out = stdout.trim(); settle(out ? resolvePath(out) : null); }
      else settle(null); // git ran and said "not a repo" → definitive, do not retry
    });
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(null, true); // timeout → transient
    }, timeoutMs);
    child.on('exit', () => clearTimeout(t));
  });
}

/**
 * Returns the canonical absolute path of the git toplevel for `cwd`, or
 * null if `cwd` is not in a git repo, git is unavailable, the directory
 * does not exist, or the spawn times out (default 5 s).
 *
 * Pure function of (cwd, filesystem state). Never throws. Retries on TRANSIENT
 * spawn failures (EAGAIN/ENOMEM/timeout — common when many git subprocesses
 * fork concurrently under load); a definitive "not a repo" result is returned
 * immediately without retry.
 */
export async function resolveGitToplevel(
  cwd: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  for (let i = 0; i < maxAttempts; i++) {
    const { value, transient } = await attemptOnce(cwd, timeoutMs);
    if (!transient) return value;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 25 * (i + 1)));
  }
  return null;
}
