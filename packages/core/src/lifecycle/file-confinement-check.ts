import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Returns the subset of worker-reported written paths that resolve OUTSIDE cwd.
 *
 * Used at task finalization to hard-fail tasks whose writes escaped the confined
 * working directory — e.g. a worker that wrote into the daemon's startup cwd or a
 * sibling git worktree instead of the dispatched `?cwd=`. The escape is detected
 * from the worker-reported write log (NOT the git diff), because the defining
 * symptom is that git-in-cwd shows clean while the worker actually wrote elsewhere.
 *
 * Containment is checked against the realpath'd cwd so a symlinked file inside cwd
 * that points outside cwd is caught. Paths that don't exist on disk (already
 * deleted, or never actually created) fall back to lexical resolution — still
 * flagged if they resolve outside cwd. Relative paths are resolved against cwd and
 * are therefore inside by construction.
 */
export function findEscapedWrites(filesWritten: readonly string[], cwd: string): string[] {
  if (filesWritten.length === 0) return [];

  let cwdReal: string;
  try {
    cwdReal = realpathSync(resolve(cwd));
  } catch {
    cwdReal = resolve(cwd);
  }

  const escaped: string[] = [];
  for (const p of filesWritten) {
    const abs = resolve(cwdReal, p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    if (real !== cwdReal && !real.startsWith(cwdReal + sep)) {
      escaped.push(p);
    }
  }
  return escaped;
}
