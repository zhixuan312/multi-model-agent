import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitCommitHandler } from '../../../packages/core/src/lifecycle/handlers/git-commit-handler.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { CommitStageResult } from '../../../packages/core/src/lifecycle/handlers/commit-stage.js';
import type { TaskSpec, RunResult } from '../../../packages/core/src/types.js';

const exec = promisify(execFile);

function makeState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    ...overrides,
  };
}

function makeCtx(cwd: string, overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const base = {
    task: { prompt: 'x', tools: 'full', timeoutMs: 60_000 } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd,
    route: 'delegate',
    client: 'test',
    mainModel: null,
    assignedTier: 'standard' as const,
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full' as const,
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
  };
  return { ...base, ...overrides };
}

describe('gitCommitHandler', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-commit-handler-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await exec('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    await exec('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('skips when state.commits is already populated (idempotency)', async () => {
    const prior: CommitStageResult = {
      sha: 'abc',
      subject: 'prior',
      body: '',
      filesChanged: [],
      authoredAt: new Date().toISOString(),
    };
    const state = makeState({ commits: [prior] });
    await gitCommitHandler(state);
    expect(state.commits).toEqual([prior]);
  });

  it('skips when state.commitError is already set', async () => {
    const state = makeState({ commitError: 'prior failure' });
    await gitCommitHandler(state);
    expect(state.commits).toBeUndefined();
    expect(state.commitError).toBe('prior failure');
  });

  it('no-ops when state.task is undefined (data flow not ready)', async () => {
    const state = makeState({ executionContext: makeCtx(repoDir) });
    await gitCommitHandler(state);
    expect(state.commits).toBeUndefined();
  });

  it('no-ops when state.executionContext is undefined', async () => {
    const state = makeState({ task: { prompt: 'x' } as TaskSpec });
    await gitCommitHandler(state);
    expect(state.commits).toBeUndefined();
  });

  it('no-ops when filesWritten is empty', async () => {
    const task = { prompt: 'x' } as TaskSpec;
    const last = { filesWritten: [] } as unknown as RunResult;
    const state = makeState({ task, executionContext: makeCtx(repoDir), lastRunResult: last });
    await gitCommitHandler(state);
    expect(state.commits).toBeUndefined();
  });

  it('commits files when filesWritten present and writes state.commits', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
    const task = { prompt: 'x' } as TaskSpec;
    const last = {
      filesWritten: ['a.txt'],
      parsedFindings: { commit: { type: 'feat', subject: 'add a.txt', body: '' } },
    } as unknown as RunResult;
    const state = makeState({ task, executionContext: makeCtx(repoDir), lastRunResult: last });

    await gitCommitHandler(state);

    expect(state.commitError).toBeUndefined();
    expect(state.commits).toBeDefined();
    expect(state.commits).toHaveLength(1);
    expect(state.commits![0].subject).toContain('add a.txt');
    expect(state.commits![0].filesChanged).toContain('a.txt');
  });

  it('records state.commitError when commit fails', async () => {
    const task = { prompt: 'x' } as TaskSpec;
    const last = {
      filesWritten: ['nonexistent.txt'],
    } as unknown as RunResult;
    const state = makeState({ task, executionContext: makeCtx(repoDir), lastRunResult: last });

    await gitCommitHandler(state);

    expect(state.commits).toBeUndefined();
    expect(typeof state.commitError).toBe('string');
  });
});
