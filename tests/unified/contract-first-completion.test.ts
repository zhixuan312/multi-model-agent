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

vi.mock('../../packages/core/src/unified/worktree-manager.js', () => {
  const WorktreeManager = vi.fn();
  WorktreeManager.prototype.create = vi.fn().mockResolvedValue({ branch: 'mma/x', path: '/tmp/wt' });
  WorktreeManager.prototype.mergeAndCleanup = vi.fn().mockResolvedValue({ branch: 'mma/x', path: '/tmp/wt', merged: true });
  WorktreeManager.prototype.remove = vi.fn().mockResolvedValue(undefined);
  return { WorktreeManager };
});

import { runTwoPhasePipeline, type PipelineInput } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { WorktreeManager } from '../../packages/core/src/unified/worktree-manager.js';
import type { ContractPlanSnapshot } from '../../packages/core/src/unified/contract-plan.js';

const mockTurn = (output: string) => ({
  output,
  usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0.01, turns: 1, durationMs: 10, terminationReason: 'ok' as const, filesWritten: [], usedShell: false,
});
const mockSession = (output: string) => ({
  send: vi.fn().mockResolvedValue(mockTurn(output)),
  close: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue('sess'),
});
const mockProvider = (s: ReturnType<typeof mockSession>) => ({ name: 'mock', config: {}, openSession: vi.fn().mockReturnValue(s) });

const snapshot: ContractPlanSnapshot = {
  tasks: [{
    title: 'Task I-9: Demo (AC-1.1)',
    contract: { inputsRequest: 'x', outputsResponse: 'y', dataMapping: 'z', errors: 'e', behaviorInvariants: 'b' },
    acceptanceTests: [{ path: 'tests/gen/demo.test.ts', source: 'test', command: 'true ok' }],
  }],
};

function baseInput(overrides: Partial<PipelineInput> & { reviewerOutput: string; run: PipelineInput['runAcceptanceCommand'] }): PipelineInput {
  const { reviewerOutput, run, ...rest } = overrides;
  return {
    type: 'execute_plan',
    implementerSkill: '# impl', reviewerSkill: '# rev', taskPayload: 'do',
    implementerProvider: mockProvider(mockSession('{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"done"}]}')),
    reviewerProvider: mockProvider(mockSession(reviewerOutput)),
    implementerTier: 'standard', reviewerTier: 'complex', reviewPolicy: 'reviewed',
    cwd: '/tmp/repo', sandboxPolicy: 'cwd-only', worktreeEnabled: true, taskId: 't1',
    dispatchedTasks: ['Task I-9: Demo (AC-1.1)'], acceptanceTestSnapshot: snapshot,
    runAcceptanceCommand: run,
    ...rest,
  };
}

describe('execute_plan contract-first completion scoring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scores 100 and merges when contract satisfied and all acceptance commands pass', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"done"}]}', run }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
    expect(r.worktree).not.toBeNull();
    expect(WorktreeManager.prototype.mergeAndCleanup).toHaveBeenCalledOnce();
    expect(WorktreeManager.prototype.remove).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('true ok', expect.any(String));
  });

  // Regression: `mma-plan` annotates task headings with the acceptance criteria they
  // satisfy — `### Task I-1: Do it (← AC-1.1, AC-1.2)` — and parseContractPlan keeps
  // that annotation in `title`, so it rides into dispatchedTasks. A reviewer echoing
  // the title back routinely drops the parenthetical. Byte-exact matching therefore
  // failed the gate at completion 60 for a correct, fully-tested implementation: the
  // plan generator emitted a format its own validator rejected.
  it('scores 100 when the reviewer omits the (← AC-…) traceability annotation from an echoed title', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const annotated = 'Task I-1: Implement the pinned-loopback stdio bridge (← AC-1.1, AC-1.2, AC-1.11b)';
    const echoedWithoutSuffix = 'Task I-1: Implement the pinned-loopback stdio bridge';
    const r = await runTwoPhasePipeline(baseInput({
      dispatchedTasks: [annotated],
      acceptanceTestSnapshot: { tasks: [{ ...snapshot.tasks[0]!, title: annotated }] },
      reviewerOutput: JSON.stringify({ tasks: [{ title: echoedWithoutSuffix, status: 'done' }] }),
      run,
    }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
    expect(WorktreeManager.prototype.mergeAndCleanup).toHaveBeenCalledOnce();
  });

  // Normalization must not create ambiguity: when two dispatched titles differ ONLY by
  // their AC annotation, stripping it would let one reviewer entry satisfy the other.
  // In that case exact matching is retained, so a partial echo still fails the gate.
  it('falls back to exact matching when stripping the annotation would collide two titles', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const a = 'Task I-1: Same name (← AC-1.1)';
    const b = 'Task I-1: Same name (← AC-2.2)';
    const r = await runTwoPhasePipeline(baseInput({
      dispatchedTasks: [a, b],
      acceptanceTestSnapshot: {
        tasks: [{ ...snapshot.tasks[0]!, title: a }, { ...snapshot.tasks[0]!, title: b }],
      },
      // Both echoed WITHOUT the annotation — indistinguishable once stripped.
      reviewerOutput: JSON.stringify({
        tasks: [{ title: 'Task I-1: Same name', status: 'done' }, { title: 'Task I-1: Same name', status: 'done' }],
      }),
      run,
    }));
    expect(r.completionPercent).toBeLessThan(80);
    expect(r.status).toBe('failed');
  });

  it('scores below 80, fails, and PRESERVES the worktree (never discards) when a reviewer task is not done', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"failed"}]}', run }));
    expect(r.completionPercent).toBeLessThan(80);
    expect(r.status).toBe('failed');
    // The worktree is PRESERVED for inspection, NOT discarded — silently deleting a (possibly complete)
    // implementation was the reported data-loss regression. It is not merged, and remove is not called.
    expect(r.worktree).not.toBeNull();
    expect(r.worktree?.merged).toBe(false);
    expect(WorktreeManager.prototype.mergeAndCleanup).not.toHaveBeenCalled();
    expect(WorktreeManager.prototype.remove).not.toHaveBeenCalled();
    expect(r.failureReason?.message ?? '').toContain('preserved');
  });

  it('keeps the executor\'s corrected test and MERGES when the plan-authored test is broken but the contract is satisfied', async () => {
    // Regression for the re-materialization data-loss: the executor\'s tests pass (1st runAll) but the
    // re-materialized FROZEN plan test fails (2nd runAll) because the plan-authored test itself is buggy.
    // With the reviewer confirming the contract, the executor\'s corrected version is accepted + kept, so
    // completion is 100 and the work merges instead of being discarded.
    let call = 0;
    const run = vi.fn().mockImplementation(async () =>
      ++call <= 1 ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'plan-authored test failed to load' });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"done"}]}', run }));
    expect(r.completionPercent).toBe(100);
    expect(r.status).toBe('done');
    expect(r.worktree).not.toBeNull();
    expect(WorktreeManager.prototype.mergeAndCleanup).toHaveBeenCalledOnce();
  });

  it('scores below 80 and fails when an acceptance command exits non-zero (even if reviewer says done)', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"done"}]}', run }));
    expect(r.completionPercent).toBeLessThan(80);
    expect(r.status).toBe('failed');
    expect(WorktreeManager.prototype.mergeAndCleanup).not.toHaveBeenCalled();
  });

  it('rejects an unknown reviewer title (not one-to-one with dispatched)', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const r = await runTwoPhasePipeline(baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-99: Ghost","status":"done"}]}', run }));
    expect(r.completionPercent).toBeLessThan(80);
    expect(r.status).toBe('failed');
  });

  it('refuses to auto-pass an execute_plan dispatched without a contract snapshot (defense-in-depth)', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const input = baseInput({ reviewerOutput: '{"tasks":[{"title":"Task I-9: Demo (AC-1.1)","status":"done"}]}', run });
    delete input.acceptanceTestSnapshot;
    const r = await runTwoPhasePipeline(input);
    expect(r.completionPercent).toBe(0);
    expect(r.status).toBe('failed');
    expect(r.failureReason?.code).toBe('missing_contract_snapshot');
    expect(WorktreeManager.prototype.mergeAndCleanup).not.toHaveBeenCalled();
  });
});
