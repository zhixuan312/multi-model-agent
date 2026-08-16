import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the filesystem-touching contract-plan materialization so these tests exercise ONLY the
// pipeline's execute_plan scoring/gate logic (materialization itself is covered by contract-plan.test.ts).
vi.mock('../../packages/core/src/unified/contract-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/core/src/unified/contract-plan.js')>();
  return {
    ...actual,
    assertSafeAcceptanceTestPaths: vi.fn().mockResolvedValue(undefined),
    materializeAcceptanceTests: vi.fn().mockResolvedValue(undefined),
    rematerializeAcceptanceTests: vi.fn().mockResolvedValue(undefined),
  };
});

// The engine now commits in the caller's checkout instead of merging a worktree, so the git
// layer is mocked to keep these pure scoring tests.
vi.mock('../../packages/core/src/unified/repo-commit.js', () => ({
  captureBaseline: vi.fn().mockResolvedValue({ head: 'abc123', branch: 'mma/2026-07-31-demo', dirtyAtDispatch: false }),
  assertRepoUntampered: vi.fn().mockResolvedValue(undefined),
  commitAll: vi.fn().mockResolvedValue({ committed: true, head: 'def456', filesChanged: ['src/a.ts'] }),
}));

import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { commitAll } from '../../packages/core/src/unified/repo-commit.js';
import type { ContractPlanSnapshot } from '../../packages/core/src/unified/contract-plan.js';

const mockTurn = (output: string) => ({
  output,
  usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0.01, turns: 1, durationMs: 10, terminationReason: 'ok' as const, filesWritten: [], usedShell: false, toolCalls: [],
});
const mockSession = (output: string) => ({
  send: vi.fn().mockResolvedValue(mockTurn(output)),
  close: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue('sess'),
});
const mockProvider = (s: ReturnType<typeof mockSession>) => ({ name: 'mock', config: {}, openSession: vi.fn().mockReturnValue(s) });

const snapshot: ContractPlanSnapshot = {
  tasks: [{
    id: 'I-9',
    title: 'Task I-9: Demo (AC-1.1)',
    output: 'src/demo.ts',
    dependencies: 'none',
    contract: { inputsRequest: 'x', outputsResponse: 'y', dataMapping: 'z', errors: 'e', behaviorInvariants: 'b' },
    acceptanceTests: [{ path: 'tests/gen/demo.test.ts', source: 'test', command: 'true ok' }],
  }],
};

function baseInput(overrides: Partial<PipelineInput> & { reviewerOutput: string; run: PipelineInput['runAcceptanceCommand'] }): PipelineInput {
  const { reviewerOutput, run, ...rest } = overrides;
  return {
    type: 'execute_plan',
    readerFacing: false,
    implementerSkill: '# impl', reviewerSkill: '# rev', taskPayload: 'do',
    implementerProvider: mockProvider(mockSession('{"tasks":[{"id":"I-9","status":"done"}]}')),
    reviewerProvider: mockProvider(mockSession(reviewerOutput)),
    implementerTier: 'standard', reviewerTier: 'complex', reviewPolicy: 'reviewed',
    cwd: '/tmp/repo', sandboxPolicy: 'cwd-only', writeRoute: true, taskId: 't1',
    dispatchedTasks: ['I-9: Task I-9: Demo (AC-1.1)'],
    dispatchedContractTasks: [{ id: 'I-9', title: 'Task I-9: Demo (AC-1.1)' }],
    acceptanceTestSnapshot: snapshot,
    runAcceptanceCommand: run,
    ...rest,
  };
}

const PASS = () => vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
const FAIL = () => vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });

/**
 * execute_plan completion REPORTING — deliberately not a gate.
 *
 * A plan is written before you know what you don't know, so an implementation legitimately
 * diverges from it, and the plan itself can be wrong. Terminally failing on that judgement used
 * to mean abandoning a whole worktree of correct work over a cosmetic mismatch. The work now
 * lands on the caller's branch, so the route delivers it and reports per task; PR review is the
 * gate. `failed` is reserved for the route not RUNNING or not DELIVERING.
 */
describe('execute_plan completion reporting (advisory, never a hard gate)', () => {
  beforeEach(() => vi.clearAllMocks());

  // --- tests PASS ---

  it('row 1: tests pass + matched + all done → done/100, commit made, no contract note', async () => {
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-9","status":"done"}]}', run: PASS() }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
    expect(r.contractNote).toBeNull();
    expect(r.worktree).toBeNull();
    expect(commitAll).toHaveBeenCalledOnce();
    expect(r.filesChangedFromGit).toEqual(['src/a.ts']);
  });

  it('row 1: a reviewer that paraphrases the title still scores 100 — ids are what match', async () => {
    const r = await runTwoPhasePipeline(baseInput({
      reviewerOutput: '{"tasks":[{"id":"I-9","title":"totally different wording","status":"done"}]}',
      run: PASS(),
    }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
    expect(r.failureReason).toBeUndefined();
  });

  it('a task reported not-done is a CONCERN, not a failure — and names the task', async () => {
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-9","status":"failed"}]}', run: PASS() }));
    expect(r.status).toBe('done_with_concerns');
    expect(r.failureReason?.code).toBe('contract_not_satisfied');
    expect(r.failureReason?.message).toContain('I-9');   // which task
    expect(r.failureReason?.message).toContain('0%');    // derived from per-task verdicts
    expect(commitAll).toHaveBeenCalledOnce();            // work is committed, never discarded
  });

  it('row 3: tests pass + UNMATCHED → done_with_concerns + contract_unverifiable, NOT failed', async () => {
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-404","status":"done"}]}', run: PASS() }));
    expect(r.status).toBe('done_with_concerns');
    expect(r.completionPercent).toBe(100);
    expect(r.failureReason).toBeUndefined();
    expect(r.contractNote?.code).toBe('contract_unverifiable');
    expect(r.contractNote?.availableTaskIds).toEqual(['I-9']);
    // FR-11: the diagnostic names what WOULD have matched.
    expect(r.contractNote?.message).toContain('I-9');
    // It must never assert the work is incomplete.
    expect(r.contractNote?.message).toContain('does NOT mean the implementation is incomplete');
    expect(commitAll).toHaveBeenCalledOnce();
  });

  // --- tests FAIL: all three rows must be `failed` / tests_failed ---

  it('failing acceptance tests are surfaced loudly but still land the work', async () => {
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-9","status":"done"}]}', run: FAIL() }));
    expect(r.status).toBe('done_with_concerns');
    expect(r.failureReason?.code).toBe('tests_failed');
    expect(r.failureReason?.message).toContain('committed on your branch');
    expect(commitAll).toHaveBeenCalledOnce();
  });

  it('never terminates `failed` for any judgement about the work', async () => {
    const cases: Array<[string, PipelineInput['runAcceptanceCommand']]> = [
      ['{"tasks":[{"id":"I-9","status":"done"}]}', PASS()],
      ['{"tasks":[{"id":"I-9","status":"failed"}]}', PASS()],
      ['{"tasks":[{"id":"I-404","status":"done"}]}', PASS()],
      ['{"tasks":[{"id":"I-9","status":"done"}]}', FAIL()],
      ['{"tasks":[{"id":"I-9","status":"failed"}]}', FAIL()],
      ['{"tasks":[{"id":"I-404","status":"done"}]}', FAIL()],
    ];
    for (const [reviewerOutput, run] of cases) {
      vi.clearAllMocks();
      const r = await runTwoPhasePipeline(baseInput({ reviewerOutput, run }));
      expect(r.status, reviewerOutput).not.toBe('failed');
      expect(commitAll).toHaveBeenCalledOnce();
    }
  });

  it('reports a DERIVED percentage naming which tasks are outstanding', async () => {
    const three = [
      { id: 'I-1', title: 'Task I-1: a' },
      { id: 'I-2', title: 'Task I-2: b' },
      { id: 'I-3', title: 'Task I-3: c' },
    ];
    const r = await runTwoPhasePipeline(baseInput({
      dispatchedContractTasks: three,
      dispatchedTasks: three.map(t => `${t.id}: ${t.title}`),
      acceptanceTestSnapshot: { tasks: three.map(t => ({ ...snapshot.tasks[0]!, id: t.id, title: t.title })) },
      reviewerOutput: '{"tasks":[{"id":"I-1","status":"done"},{"id":"I-2","status":"done"},{"id":"I-3","status":"failed"}]}',
      run: PASS(),
    }));
    expect(r.completionPercent).toBe(67);                              // 2 of 3
    expect(r.failureReason?.message).toContain('Not done: I-3');       // names the outstanding task
    expect(r.failureReason?.message).toContain('done: I-1, I-2');      // and what did land
    expect(r.status).toBe('done_with_concerns');
  });

  it('keeps the executor\'s corrected test when the plan-authored test is broken but the contract is satisfied', async () => {
    // The executor's own tests pass (1st runAll) but the re-materialized FROZEN plan test fails
    // (2nd runAll) because the plan-authored test itself is buggy. With the reviewer confirming
    // the contract, the executor's corrected version is accepted and completion is 100.
    let call = 0;
    const run = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'frozen test bug' };
    });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-9","status":"done"}]}', run }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
  });

  it('runs the plan-authored acceptance command', async () => {
    const run = PASS();
    await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"id":"I-9","status":"done"}]}', run }));
    expect(run).toHaveBeenCalledWith('true ok', expect.any(String));
  });
});
