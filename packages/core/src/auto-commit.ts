import { execFileSync } from 'child_process';
import { resolve, relative } from 'path';

const FALLBACK_MESSAGE = 'worker: task completed';

export interface AutoCommitResult {
  sha?: string;
  error?: string;
}

/**
 * Stage and commit the given files via git.
 * Returns the commit SHA on success, or an error message on failure.
 * "Nothing to commit" is treated as a benign no-op (no error, no SHA).
 */
export function autoCommitFiles(
  filesWritten: string[],
  summary: string | undefined,
  cwd: string,
): AutoCommitResult {
  // Resolve all paths and filter to those inside cwd (cross-platform)
  const contained: string[] = [];
  for (const fp of filesWritten) {
    const abs = resolve(cwd, fp);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) continue;
    contained.push(rel);
  }

  if (contained.length === 0) return {};

  const message = summary?.trim() || FALLBACK_MESSAGE;

  try {
    // Use git add + git commit with explicit pathspec to avoid committing
    // unrelated pre-existing staged changes from the working tree
    execFileSync('git', ['add', ...contained], { cwd });
    execFileSync('git', ['commit', '-m', message, '--', ...contained], { cwd });
    const shaOut = execFileSync('git', ['rev-parse', 'HEAD'], { cwd });
    return { sha: shaOut.toString().trim() };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stderr = (err as any)?.stderr?.toString?.() ?? '';
    if (errMsg.includes('nothing to commit') || stderr.includes('nothing to commit')) {
      return {}; // benign no-op
    }
    return { error: errMsg };
  }
}