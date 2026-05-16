import { spawn } from 'node:child_process';

export interface DirtyFilesOptions { timeoutMs?: number }

/**
 * Returns the list of porcelain-reported dirty file paths in cwd, or []
 * on any failure (timeout, spawn error, non-git repo). Never throws.
 */
export async function getDirtyFiles(
  cwd: string,
  opts: DirtyFilesOptions = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string[]) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn('git', ['-C', cwd, 'status', '--porcelain'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      done([]); return;
    }
    let out = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', () => {});
    child.on('error', () => done([]));
    child.on('exit', (code) => {
      if (code !== 0) { done([]); return; }
      const files = out.split('\n')
        .filter(Boolean)
        .map((l) => {
          const path = l.substring(3);
          if (path.startsWith('"') && path.endsWith('"')) {
            try {
              return JSON.parse(path);
            } catch {
              return path;
            }
          }
          return path;
        })
        .filter(Boolean);
      done(files);
    });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done([]); }, timeoutMs);
    child.on('exit', () => clearTimeout(t));
  });
}

/**
 * Builds the [REPO HYGIENE] advisory string. Sorts files lexicographically;
 * lists the first 20 and appends ", … (+N more)" when N > 0.
 */
export function formatHygieneAdvisory(files: string[]): string {
  const sorted = [...files].sort();
  const shown = sorted.slice(0, 20);
  const remaining = sorted.length - shown.length;
  const list = shown.join(', ') + (remaining > 0 ? `, … (+${remaining} more)` : '');
  return (
    '[REPO HYGIENE] The previous task in this serial group left uncommitted ' +
    `changes in the following files: ${list}. Review these before editing ` +
    'the same paths; your `getRealFilesChanged` will attribute them to your ' +
    'task if you commit.\n\n'
  );
}
