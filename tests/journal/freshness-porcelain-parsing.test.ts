import { vi } from 'vitest';
import { detectGitChanges } from '../../packages/core/src/journal/engine/freshness.js';

// `detectGitChanges` shells out to `git status --porcelain -z`. To exercise
// the exact NUL-delimited token sequence git emits for a copy (`C`) status —
// without depending on whether the local git binary/config actually performs
// copy detection for a given repository — stub `execFile` and hand it a
// hand-built porcelain payload. `-c status.renames=copies` gating whether
// git even LOOKS for copies is an operational git-config concern; this test
// is only about correctly parsing the tokens once git decides to report one.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

function mockStatusOutput(stdout: string): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr: '' });
    },
  );
}

it('consumes the extra old-path token for a staged copy entry, without deleting the copy source', async () => {
  mockStatusOutput('R  new1.ts\0old1.ts\0C  copy1.ts\0source1.ts\0M  plain.ts\0');

  const result = await detectGitChanges('/fake/root');

  expect(result).not.toBeNull();
  expect(result!.changedPaths).toEqual(['new1.ts', 'copy1.ts', 'plain.ts']);
  expect(result!.deletedPaths).toEqual(['old1.ts']);
});

it('consumes the extra old-path token for an unstaged (worktree-side) rename and copy entry', async () => {
  mockStatusOutput(' R new2.ts\0old2.ts\0 C copy2.ts\0source2.ts\0');

  const result = await detectGitChanges('/fake/root');

  expect(result).not.toBeNull();
  expect(result!.changedPaths).toEqual(['new2.ts', 'copy2.ts']);
  expect(result!.deletedPaths).toEqual(['old2.ts']);
});

it('does not leak an unconsumed copy old-path token into the next status record', async () => {
  // Pre-fix, only R consumed the extra token: a C entry left `source3.ts`
  // to be misparsed as its own status record on the NEXT loop iteration.
  mockStatusOutput('C  copy3.ts\0source3.ts\0M  next.ts\0');

  const result = await detectGitChanges('/fake/root');

  expect(result).not.toBeNull();
  expect(result!.changedPaths).toEqual(['copy3.ts', 'next.ts']);
  expect(result!.deletedPaths).toEqual([]);
});
