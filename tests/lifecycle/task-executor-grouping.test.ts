import { describe, it, expect, vi } from 'vitest';
import { withTempGitRepo } from './with-temp-git-repo.js';

// Use a tiny harness that mimics the executor's dispatch shape without
// pulling in the full pipeline. We exercise the helper `dispatchGrouped`
// (extracted in step 3) directly.
import { dispatchGrouped } from '../../packages/core/src/lifecycle/task-executor.js';
import type { TaskSpec } from '../../packages/core/src/types/task-spec.js';

function gatedTask(cwd: string, idx: number, release: Promise<void>, started: number[]): TaskSpec {
  return { prompt: `task-${idx}`, cwd };
}

describe('task-executor grouped dispatch', () => {
  it('runs same-repo group of 3 sequentially in input order', async () => {
    await withTempGitRepo(async (repo) => {
      const started: number[] = [];
      const releases = [
        deferred<void>(), deferred<void>(), deferred<void>(),
      ];
      const dispatchOne = async (_t: TaskSpec, i: number) => {
        started.push(i);
        await releases[i]!.promise;
        return makeOk(i);
      };
      const tasks = [0, 1, 2].map((i) =>
        ({ prompt: `t${i}`, cwd: repo } as TaskSpec));

      const run = dispatchGrouped(tasks, dispatchOne, {});

      // Only task 0 should have started before any release.
      await sleep(20);
      expect(started).toEqual([0]);

      releases[0]!.resolve();
      await sleep(20);
      expect(started).toEqual([0, 1]);

      releases[1]!.resolve();
      await sleep(20);
      expect(started).toEqual([0, 1, 2]);

      releases[2]!.resolve();
      const results = await run;
      expect(results.map((r: any) => r.idx)).toEqual([0, 1, 2]);
    });
  });

  it('runs two cross-repo groups in parallel, serial within each', async () => {
    await withTempGitRepo(async (repoA) => {
      await withTempGitRepo(async (repoB) => {
        const started: number[] = [];
        const releases = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
        const dispatchOne = async (_t: TaskSpec, i: number) => {
          started.push(i);
          await releases[i]!.promise;
          return makeOk(i);
        };
        const tasks: TaskSpec[] = [
          { prompt: 't0', cwd: repoA },
          { prompt: 't1', cwd: repoB },
          { prompt: 't2', cwd: repoA },
          { prompt: 't3', cwd: repoB },
        ];

        const run = dispatchGrouped(tasks, dispatchOne, {});
        await sleep(20);
        // One task per group should have started: tasks[0] (A) and tasks[1] (B).
        expect(started.sort()).toEqual([0, 1]);

        releases[0]!.resolve(); releases[1]!.resolve();
        await sleep(20);
        expect(started.sort()).toEqual([0, 1, 2, 3]);

        releases[2]!.resolve(); releases[3]!.resolve();
        const results = await run;
        expect(results).toHaveLength(4);
      });
    });
  });

  it('continues to subsequent tasks in a group after a middle failure', async () => {
    await withTempGitRepo(async (repo) => {
      const dispatchOne = async (_t: TaskSpec, i: number) => {
        if (i === 1) return { ...makeOk(i), workerStatus: 'failed' as const, errorCode: 'sim_failure' };
        return makeOk(i);
      };
      const tasks = [0, 1, 2].map((i) => ({ prompt: `t${i}`, cwd: repo } as TaskSpec));
      const results = await dispatchGrouped(tasks, dispatchOne, {});
      expect(results).toHaveLength(3);
      expect((results[0] as any).workerStatus).not.toBe('failed');
      expect((results[1] as any).workerStatus).toBe('failed');
      expect((results[2] as any).workerStatus).not.toBe('failed');
    });
  });

  it('fills cancelled slots after abort fires', async () => {
    await withTempGitRepo(async (repo) => {
      const controller = new AbortController();
      const release0 = deferred<void>();
      let invocations = 0;
      const dispatchOne = async (_t: TaskSpec, i: number) => {
        invocations++;
        if (i === 0) { await release0.promise; return makeOk(0); }
        return makeOk(i);
      };
      const tasks = [0, 1, 2].map((i) => ({ prompt: `t${i}`, cwd: repo } as TaskSpec));
      const run = dispatchGrouped(tasks, dispatchOne, { abortSignal: controller.signal });
      await sleep(20);
      controller.abort();
      release0.resolve();
      const results = await run;
      expect(results).toHaveLength(3);
      expect((results[0] as any).workerStatus).not.toBe('failed');
      expect((results[1] as any).errorCode).toBe('cancelled');
      expect((results[2] as any).errorCode).toBe('cancelled');
      expect(invocations).toBe(1); // only task 0 invoked dispatchOne
    });
  });
});

// Helpers
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function makeOk(i: number) {
  return {
    idx: i, output: '', status: 'ok' as const,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false,
    escalationLog: [], durationMs: 1, workerStatus: 'done' as const, actualCostUSD: 0,
    directoriesListed: [],
  };
}
