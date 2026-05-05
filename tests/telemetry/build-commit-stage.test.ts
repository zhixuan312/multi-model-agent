import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import type { RunResult } from '../../packages/core/src/types.js';
import { HAPPY } from './fixtures/runresult.js';

function withCommits(commits: any): RunResult {
  const rr = structuredClone(HAPPY);
  (rr as any).commits = commits;
  return rr;
}

describe('buildCommitStage filesCommittedCount', () => {
  it('counts unique files across all commits', () => {
    const rr = withCommits([
      { sha: 'a', subject: '', body: '', filesChanged: ['src/a.ts', 'src/b.ts'], authoredAt: '' },
      { sha: 'b', subject: '', body: '', filesChanged: ['src/a.ts', 'src/c.ts'], authoredAt: '' },
    ]);
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const commit = ev.stages.find(s => s.name === 'committing')!;
    expect((commit as any).filesCommittedCount).toBe(3);
    expect((commit as any).branchCreated).toBe(false);
  });

  it('clamps at 1000', () => {
    const files = Array.from({ length: 1500 }, (_, i) => `src/file${i}.ts`);
    const rr = withCommits([{ sha: 'a', subject: '', body: '', filesChanged: files, authoredAt: '' }]);
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const commit = ev.stages.find(s => s.name === 'committing')!;
    expect((commit as any).filesCommittedCount).toBe(1000);
  });

  it('returns 0 when commits is null/undefined/empty', () => {
    for (const c of [null, undefined, []]) {
      const rr = withCommits(c);
      const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
      const commit = ev.stages.find(s => s.name === 'committing')!;
      expect((commit as any).filesCommittedCount).toBe(0);
    }
  });

  it('does not throw on malformed commits (non-array, missing filesChanged, non-string entries)', () => {
    const malformed: any[] = [
      'not-a-commit',
      null,
      { sha: 'a' },
      { sha: 'b', filesChanged: 'not-array' },
      { sha: 'c', filesChanged: [null, 42, 'src/valid.ts'] },
    ];
    const rr = withCommits(malformed);
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const commit = ev.stages.find(s => s.name === 'committing')!;
    expect((commit as any).filesCommittedCount).toBe(1);
  });
});
