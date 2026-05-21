import { execFileSync } from 'node:child_process';

export interface CommitResult { commitSha?: string; errorCode?: string }

export class CommitStageRunner {
  run(opts: { cwd: string; message: string; expectedFiles: string[] }): CommitResult {
    try {
      // argv form: paths are individual array elements, no quoting needed
      execFileSync('git', ['add', '--', ...opts.expectedFiles], { cwd: opts.cwd, windowsHide: true });
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: opts.cwd, windowsHide: true }).toString();

      // porcelain v1 prefixes are TWO chars [XY] where X = staged, Y = unstaged.
      // Treat any non-empty line whose staged-half (first char) is NOT a known clean staged
      // marker (' ', 'A', 'M', 'D', 'R', 'C') as a "dirty" signal — and ANY non-' ' unstaged
      // half (second char) means an uncommitted change still sits beside the staged set.
      // Also flag '?' (untracked) and 'U' (unmerged) explicitly.
      const STAGED_OK = new Set([' ', 'A', 'M', 'D', 'R', 'C']);
      const dirty = status.split('\n').filter(l => {
        if (!l) return false;
        const x = l[0] ?? ' ';
        const y = l[1] ?? ' ';
        if (x === '?' || y === '?') return true;     // untracked
        if (x === 'U' || y === 'U') return true;     // unmerged
        if (!STAGED_OK.has(x)) return true;          // unknown staged marker
        if (y !== ' ') return true;                  // any unstaged-half hunk = dirty
        return false;
      }).length;
      if (dirty > 0) return { errorCode: 'validator_dirty_worktree' };

      // -m takes the literal message as an argv element — no escape ladder
      execFileSync('git', ['commit', '-m', opts.message], { cwd: opts.cwd, windowsHide: true });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd, windowsHide: true }).toString().trim();
      return { commitSha: sha };
    } catch (e: any) {
      if (e.message?.includes('nothing to commit')) return { errorCode: 'validator_no_changes' };
      throw e;
    }
  }
}
