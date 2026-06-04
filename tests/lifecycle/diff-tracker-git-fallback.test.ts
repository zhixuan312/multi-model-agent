import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DiffTracker } from '../../packages/core/src/lifecycle/diff-tracker.js';

const execP = promisify(execFile);

/**
 * 4.2.3+ — DiffTracker.cumulativeDiff() falls back to `git diff` when
 * snapshot-based diff is empty (no pre-declared paths changed).
 *
 * This is the bug observed during A1.4 dispatch: mma-execute-plan
 * snapshots only the plan markdown (the only filePath in task.filePaths),
 * but the worker actually modifies source files derived from the plan's
 * own contents. The snapshot diff stays empty even when the worker did
 * substantial real work, and the spec_review wrongly rejects every
 * round with "cumulative diff is empty."
 *
 * Fix: when snapshot diff is empty AND we're in a git repo, use git's
 * working-tree diff plus untracked-file synthesis.
 */
describe('DiffTracker git fallback (4.2.3+)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mma-diff-tracker-git-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function gitInit(): Promise<void> {
    await execP('git', ['init', '-q', '-b', 'main'], { cwd });
    await execP('git', ['config', 'user.email', 'test@example.com'], { cwd });
    await execP('git', ['config', 'user.name', 'Test'], { cwd });
    await execP('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  }

  async function gitCommit(message: string): Promise<void> {
    await execP('git', ['add', '-A'], { cwd });
    await execP('git', ['commit', '-q', '-m', message, '--no-verify'], { cwd });
  }

  it('non-git cwd: empty snapshot baselines → empty diff (no fallback noise)', async () => {
    const tracker = new DiffTracker(cwd);
    // No snapshot, no git — must return empty without crashing
    const diff = await tracker.cumulativeDiff();
    expect(diff).toBe('');
  });

  it('git cwd, clean tree: empty snapshot baselines → empty diff', async () => {
    await gitInit();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'initial\n');
    await gitCommit('initial');
    const tracker = new DiffTracker(cwd);
    const diff = await tracker.cumulativeDiff();
    expect(diff).toBe('');
  });

  it('git cwd, modified file outside snapshot: fallback recovers the diff', async () => {
    await gitInit();
    await fs.writeFile(path.join(cwd, 'src.ts'), 'export const x = 1;\n');
    await gitCommit('initial');
    // Tracker only knows about a different file (mimics mma-execute-plan
    // where filePaths is the plan, not the source).
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['some-unrelated-plan.md']);
    // Worker modifies src.ts — NOT in snapshot baselines
    await fs.writeFile(path.join(cwd, 'src.ts'), 'export const x = 2;\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).not.toBe('');
    expect(diff).toContain('src.ts');
    // The change must be visible
    expect(diff).toContain('-export const x = 1;');
    expect(diff).toContain('+export const x = 2;');
  });

  it('git cwd, untracked new file outside snapshot: fallback synthesizes new-file diff', async () => {
    await gitInit();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'a\n');
    await gitCommit('initial');
    const tracker = new DiffTracker(cwd);
    // Worker creates a new file the tracker never heard about
    await fs.mkdir(path.join(cwd, 'tests'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'tests/new-test.ts'), 'export const t = 1;\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).not.toBe('');
    expect(diff).toContain('tests/new-test.ts');
    expect(diff).toContain('+export const t = 1;');
    // New file → /dev/null on the LHS
    expect(diff).toContain('/dev/null');
  });

  it('snapshot diff non-empty: fallback DOES NOT fire (no double-render)', async () => {
    await gitInit();
    await fs.writeFile(path.join(cwd, 'foo.ts'), 'before\n');
    await gitCommit('initial');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['foo.ts']);
    await fs.writeFile(path.join(cwd, 'foo.ts'), 'after\n');
    const diff = await tracker.cumulativeDiff();
    // Snapshot diff handles foo.ts; git fallback doesn't run because
    // snapshot already produced non-empty output. Should see the diff
    // exactly once.
    const matches = (diff.match(/foo\.ts/g) ?? []).length;
    expect(matches).toBeGreaterThan(0);
    // Don't assert exact count — `--- a/foo.ts` + `+++ b/foo.ts` = 2;
    // the duplicate concern is whether the SAME hunk shows up twice.
    // Verify only one `@@ ... @@` header per file.
    const hunkHeaders = (diff.match(/^@@/gm) ?? []).length;
    expect(hunkHeaders).toBe(1);
  });

  it('git cwd, both modified-tracked AND new-untracked: fallback combines both', async () => {
    await gitInit();
    await fs.writeFile(path.join(cwd, 'tracked.ts'), 'x\n');
    await gitCommit('initial');
    const tracker = new DiffTracker(cwd);
    // Worker modifies tracked + creates untracked, neither in snapshot
    await fs.writeFile(path.join(cwd, 'tracked.ts'), 'x-modified\n');
    await fs.writeFile(path.join(cwd, 'new.ts'), 'fresh\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('tracked.ts');
    expect(diff).toContain('new.ts');
    expect(diff).toContain('+x-modified');
    expect(diff).toContain('+fresh');
  });
});
