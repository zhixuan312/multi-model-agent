import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

export interface ResolveOptions {
  /** Per-attempt spawn timeout (ms). Default 5000. Total worst-case wall time is
   *  bounded by `maxAttempts × timeoutMs` only when every attempt is a transient
   *  fork failure; a timeout itself is definitive and is NOT retried. */
  timeoutMs?: number;
  /** Max spawn attempts on a TRANSIENT fork failure (EAGAIN/ENOMEM). Default 3.
   *  Coerced to a positive integer; non-finite values fall back to 3. */
  maxAttempts?: number;
}

/** Outcome of one spawn attempt. `transient` = a spawn-level fork failure
 *  (EAGAIN/ENOMEM) worth retrying. Everything else — a clean non-zero exit
 *  (not a repo), a permanent spawn error (ENOENT: git not installed), or a
 *  timeout — is definitive and returned immediately without retry. */
interface Attempt { value: string | null; transient: boolean; }

/** True only for the fork-pressure spawn errors this retry path targets.
 *  ENOENT (git missing), EACCES, signal-kills, etc. are permanent → no retry. */
function isTransientSpawnError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 'EAGAIN' || code === 'ENOMEM';
}

function attemptOnce(cwd: string, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: string | null, transient = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // free the timer on EVERY exit path (incl. 'error')
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
    } catch (err) {
      settle(null, isTransientSpawnError(err)); // sync throw: retry only EAGAIN/ENOMEM
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', () => { /* swallow */ });
    // Retry only the fork-pressure failure class; ENOENT (git missing) and other
    // permanent spawn errors are definitive.
    child.on('error', (err) => settle(null, isTransientSpawnError(err)));
    child.on('exit', (code) => {
      // `git --show-toplevel` emits forward-slash paths even on Windows;
      // normalize to an OS-native absolute path so callers comparing against
      // realpath/process.cwd() (backslashes on win32) match.
      if (code === 0) { const out = stdout.trim(); settle(out ? resolvePath(out) : null); }
      else settle(null); // git ran and said "not a repo" → definitive, do not retry
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Timeout is definitive: retrying would triple the worst-case stall on the
      // commit critical path. Caller falls back (?? cwd) immediately instead.
      settle(null, false);
    }, timeoutMs);
  });
}

/**
 * Returns the canonical absolute path of the git toplevel for `cwd`, or
 * null if `cwd` is not in a git repo, git is unavailable (ENOENT), the
 * directory does not exist, or the spawn times out (default 5 s).
 *
 * Pure function of (cwd, filesystem state). Never throws. Retries ONLY transient
 * fork failures (EAGAIN/ENOMEM — common when many git subprocesses fork
 * concurrently under load), up to `maxAttempts`. A "not a repo" exit, a missing
 * git binary (ENOENT), and a timeout are all definitive and returned immediately.
 */
export async function resolveGitToplevel(
  cwd: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const rawAttempts = opts.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(rawAttempts) ? Math.max(1, Math.floor(rawAttempts)) : 3;
  for (let i = 0; i < maxAttempts; i++) {
    const { value, transient } = await attemptOnce(cwd, timeoutMs);
    if (!transient) return value;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 25 * (i + 1)));
  }
  return null;
}
