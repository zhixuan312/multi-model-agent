import { execFile } from 'node:child_process';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { composeCommitMessage } from '../auto-commit.js';
import type { CommitFields } from '../reporting/structured-report.js';

const exec = promisify(execFile);

export interface CommitStageInput {
  cwd: string;
  filesWritten: string[];
  commit: CommitFields;
}

export interface CommitStageResult {
  sha: string;
  subject: string;
  body: string;
  filesChanged: string[];
  authoredAt: string;
}

function validatePaths(cwd: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (/[\x00-\x1f]/.test(p)) throw new Error(`commit-stage: path contains control chars: ${JSON.stringify(p)}`);

    let candidate: string;
    if (isAbsolute(p)) {
      const rel = relative(cwd, normalize(p));
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`commit-stage: absolute path outside cwd rejected: ${p}`);
      }
      candidate = rel;
    } else {
      const norm = normalize(p);
      const rel = relative(cwd, normalize(`${cwd}/${norm}`));
      if (rel.startsWith('..')) throw new Error(`commit-stage: path escapes cwd: ${p}`);
      candidate = norm;
    }

    out.push(candidate);
  }
  return out;
}

export async function readbackCommit(sha: string, cwd: string): Promise<CommitStageResult> {
  const { stdout: meta } = await exec('git', ['log', '-1', sha, '--format=%H%n%cI%n%s%n%b'], { cwd });
  const lines = meta.split('\n');
  const [shaOut, isoCi, subject, ...bodyLines] = lines;
  const { stdout: names } = await exec('git', ['log', '-1', sha, '--name-only', '--format='], { cwd });
  const filesChanged = names.split('\n').map(s => s.trim()).filter(Boolean);
  const authoredAt = new Date(isoCi).toISOString();
  return { sha: shaOut, subject, body: bodyLines.join('\n').trimEnd(), filesChanged, authoredAt };
}

export async function runCommitStage(input: CommitStageInput): Promise<CommitStageResult> {
  if (input.filesWritten.length === 0) {
    throw new Error('commit-stage: filesWritten must not be empty (call only when treeDirty)');
  }
  const safePaths = validatePaths(input.cwd, input.filesWritten);
  await exec('git', ['add', '--', ...safePaths], { cwd: input.cwd });

  const message = composeCommitMessage(input.commit);
  const [subjectFull, body] = message.split(/\n\n([\s\S]*)/, 2);
  const commitArgs = ['commit', '-q', '-m', subjectFull, ...(body ? ['-m', body] : [])];
  await exec('git', commitArgs, { cwd: input.cwd });

  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: input.cwd });
  return readbackCommit(head.trim(), input.cwd);
}
