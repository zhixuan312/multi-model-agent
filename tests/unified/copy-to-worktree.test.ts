import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const tmpBase = mkdtempSync(join(tmpdir(), 'mma-copy-test-'));
afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

async function copyToWorktreeIfMissing(srcCwd: string, dstCwd: string, relPaths: string[]) {
  for (const relPath of relPaths) {
    const src = join(srcCwd, relPath);
    const dst = join(dstCwd, relPath);
    if (existsSync(src) && !existsSync(dst)) {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
  }
}

describe('copyToWorktree mechanism', () => {
  it('copies a file from original cwd to worktree when missing', async () => {
    const srcCwd = join(tmpBase, 'src1');
    const dstCwd = join(tmpBase, 'dst1');
    mkdirSync(srcCwd, { recursive: true });
    mkdirSync(dstCwd, { recursive: true });
    writeFileSync(join(srcCwd, 'plan.md'), '# Plan\n### Task 1\n');

    await copyToWorktreeIfMissing(srcCwd, dstCwd, ['plan.md']);

    expect(existsSync(join(dstCwd, 'plan.md'))).toBe(true);
    expect(readFileSync(join(dstCwd, 'plan.md'), 'utf8')).toBe('# Plan\n### Task 1\n');
  });

  it('creates nested directories if needed', async () => {
    const srcCwd = join(tmpBase, 'src2');
    const dstCwd = join(tmpBase, 'dst2');
    mkdirSync(join(srcCwd, '.mma', 'projects'), { recursive: true });
    mkdirSync(dstCwd, { recursive: true });
    writeFileSync(join(srcCwd, '.mma', 'projects', 'plan.md'), 'nested plan');

    await copyToWorktreeIfMissing(srcCwd, dstCwd, ['.mma/projects/plan.md']);

    expect(readFileSync(join(dstCwd, '.mma', 'projects', 'plan.md'), 'utf8')).toBe('nested plan');
  });

  it('does not overwrite if file already exists in worktree', async () => {
    const srcCwd = join(tmpBase, 'src3');
    const dstCwd = join(tmpBase, 'dst3');
    mkdirSync(srcCwd, { recursive: true });
    mkdirSync(dstCwd, { recursive: true });
    writeFileSync(join(srcCwd, 'plan.md'), 'source version');
    writeFileSync(join(dstCwd, 'plan.md'), 'worktree version');

    await copyToWorktreeIfMissing(srcCwd, dstCwd, ['plan.md']);

    expect(readFileSync(join(dstCwd, 'plan.md'), 'utf8')).toBe('worktree version');
  });

  it('silently skips if source file does not exist', async () => {
    const srcCwd = join(tmpBase, 'src4');
    const dstCwd = join(tmpBase, 'dst4');
    mkdirSync(srcCwd, { recursive: true });
    mkdirSync(dstCwd, { recursive: true });

    await copyToWorktreeIfMissing(srcCwd, dstCwd, ['nonexistent.md']);

    expect(existsSync(join(dstCwd, 'nonexistent.md'))).toBe(false);
  });
});
