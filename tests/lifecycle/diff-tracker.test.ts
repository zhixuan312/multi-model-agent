import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiffTracker } from '../../packages/core/src/lifecycle/diff-tracker.js';

// Tool sweep #6 — snapshot-based diff tracker that lets reviewer
// stages see actual code changes (not the worker's text claim).

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mma-diff-tracker-'));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.resolve(cwd, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

describe('DiffTracker.snapshot + cumulativeDiff', () => {
  it('returns empty diff when nothing has changed', async () => {
    await write('a.ts', 'line 1\nline 2\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    expect(await tracker.cumulativeDiff()).toBe('');
  });

  it('emits a unified diff for a single-line edit', async () => {
    await write('a.ts', 'line 1\nline 2\nline 3\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    await write('a.ts', 'line 1\nLINE 2\nline 3\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('--- a/a.ts');
    expect(diff).toContain('+++ b/a.ts');
    expect(diff).toContain('-line 2');
    expect(diff).toContain('+LINE 2');
  });

  it('detects new files (baseline=null → full file diff)', async () => {
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['new.ts']); // doesn't exist yet
    await write('new.ts', 'hello\nworld\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/new.ts');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('detects deleted files', async () => {
    await write('doomed.ts', 'goodbye\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['doomed.ts']);
    await fs.unlink(path.resolve(cwd, 'doomed.ts'));
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('--- a/doomed.ts');
    expect(diff).toContain('+++ /dev/null');
    expect(diff).toContain('-goodbye');
  });

  it('emits cumulative diffs across multiple files', async () => {
    await write('a.ts', 'A\n');
    await write('b.ts', 'B\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts', 'b.ts']);
    await write('a.ts', 'AAA\n');
    await write('b.ts', 'BBB\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('--- a/a.ts');
    expect(diff).toContain('--- a/b.ts');
    expect(diff).toContain('+AAA');
    expect(diff).toContain('+BBB');
  });

  it('captures cumulative changes across multiple rework rounds', async () => {
    await write('a.ts', 'X\nY\nZ\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    // Round 1: edit Y → Y1
    await write('a.ts', 'X\nY1\nZ\n');
    const round1Diff = await tracker.cumulativeDiff();
    expect(round1Diff).toContain('-Y');
    expect(round1Diff).toContain('+Y1');
    // Round 2: also edit Z → Z1 (Y is still Y1)
    await write('a.ts', 'X\nY1\nZ1\n');
    const round2Diff = await tracker.cumulativeDiff();
    // Cumulative — must show BOTH Y→Y1 and Z→Z1 against the original baseline.
    expect(round2Diff).toContain('-Y');
    expect(round2Diff).toContain('+Y1');
    expect(round2Diff).toContain('-Z');
    expect(round2Diff).toContain('+Z1');
  });

  it('snapshot is idempotent — earliest baseline wins', async () => {
    await write('a.ts', 'original\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    // Second snapshot must NOT overwrite the baseline (which represents
    // pre-task state). If a worker creates a file mid-run and we lazy-
    // snapshot it, the baseline reflects pre-write state. But for files
    // already snapshotted at task start, we must keep the original.
    await write('a.ts', 'rewritten\n');
    await tracker.snapshot(['a.ts']);
    const diff = await tracker.cumulativeDiff();
    // Baseline still 'original\n', current is 'rewritten\n' → diff exists
    expect(diff).toContain('-original');
    expect(diff).toContain('+rewritten');
  });

  it('hunk header reports correct line numbers for mid-file edits', async () => {
    const original = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n';
    await write('a.ts', original);
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    const modified = ['1', '2', '3', '4', '5', '5.5', '6', '7', '8', '9', '10'].join('\n') + '\n';
    await write('a.ts', modified);
    const diff = await tracker.cumulativeDiff();
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('+5.5');
  });

  it('caps output at 50KB with a truncation marker', async () => {
    // 70KB of unique lines on each side → diff well over 50KB
    const lines = Array.from({ length: 5000 }, (_, i) => `line${i}`);
    await write('big.ts', lines.join('\n') + '\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['big.ts']);
    await write('big.ts', lines.map(l => l + 'X').join('\n') + '\n');
    const diff = await tracker.cumulativeDiff();
    // 50KB cap + small marker overrun ≤ 200 chars.
    expect(diff.length).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(diff).toContain('[diff truncated at');
  });

  it('ensureSnapshotted lazy-captures paths not declared at start', async () => {
    await write('a.ts', 'A\n');
    const tracker = new DiffTracker(cwd);
    await tracker.snapshot(['a.ts']);
    // Worker writes b.ts that wasn't in filePaths. Lazy-capture before edit:
    await tracker.ensureSnapshotted('b.ts'); // doesn't exist → baseline=null
    await write('b.ts', 'new file\n');
    const diff = await tracker.cumulativeDiff();
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/b.ts');
    expect(diff).toContain('+new file');
  });

  it('size() returns the count of snapshotted paths', async () => {
    const tracker = new DiffTracker(cwd);
    expect(tracker.size()).toBe(0);
    await tracker.snapshot(['a.ts', 'b.ts', 'c.ts']);
    expect(tracker.size()).toBe(3);
  });
});
