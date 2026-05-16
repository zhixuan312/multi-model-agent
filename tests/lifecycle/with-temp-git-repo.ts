import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Creates a fresh git repo in a temp directory, runs `fn(repoPath)`,
 * then deletes the temp directory. Caller receives the canonical realpath
 * of the repo root (already resolved through symlinks).
 */
export async function withTempGitRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(join(tmpdir(), 'mma-test-repo-'));
  const repoPath = await fs.realpath(base);
  await runGit(repoPath, ['init', '-q']);
  await runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  await runGit(repoPath, ['config', 'user.name', 'Test']);
  await runGit(repoPath, ['commit', '--allow-empty', '-m', 'init', '-q']);
  try {
    return await fn(repoPath);
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exit ${code}`))));
    p.on('error', reject);
  });
}
