import { runCommitStage } from '@zhixuan92/multi-model-agent-core/run-tasks/commit-stage.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function initRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-stage-'));
  execSync('git init -q && git config user.email t@e && git config user.name T && git config commit.gpgsign false', { cwd });
  writeFileSync(join(cwd, 'README.md'), '# hi');
  execSync('git add . && git commit -q -m "init"', { cwd });
  return cwd;
}

describe('runCommitStage', () => {
  it('stages files, commits, returns sha + parsed git log', async () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, 'a.txt'), 'a');
    const result = await runCommitStage({
      cwd,
      filesWritten: ['a.txt'],
      commit: { type: 'feat', scope: 'core', subject: 'add a' }
    });
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.subject).toBe('feat(core): add a');
    expect(result.body).toBe('');
    expect(result.filesChanged).toContain('a.txt');
    expect(result.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.000Z$/);
  });

  it('accepts absolute paths inside cwd and commits them as relative paths', async () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, 'inside.txt'), 'inside');
    const result = await runCommitStage({
      cwd,
      filesWritten: [join(cwd, 'inside.txt')],
      commit: { type: 'feat', scope: 'core', subject: 'add inside' }
    });
    expect(result.filesChanged).toContain('inside.txt');
  });

  it('rejects absolute paths outside cwd', async () => {
    const cwd = initRepo();
    await expect(runCommitStage({
      cwd,
      filesWritten: [join(tmpdir(), 'elsewhere.txt')],
      commit: { type: 'feat', scope: 'core', subject: 'add elsewhere' }
    })).rejects.toThrow(/outside cwd/);
  });

  it('rejects relative paths that escape cwd', async () => {
    const cwd = initRepo();
    await expect(runCommitStage({
      cwd,
      filesWritten: ['../foo'],
      commit: { type: 'feat', scope: 'core', subject: 'add foo' }
    })).rejects.toThrow(/escapes cwd/);
  });

  it('rejects paths with control chars', async () => {
    const cwd = initRepo();
    await expect(runCommitStage({
      cwd,
      filesWritten: ['bad\npath.txt'],
      commit: { type: 'feat', scope: 'core', subject: 'add bad' }
    })).rejects.toThrow(/control chars/);
  });
});
