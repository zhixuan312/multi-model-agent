// tests/lifecycle/annotate-parser.test.ts
//
// Task 17a — exercises `applyAnnotatePreconditions` (the deterministic
// parser that gates AnnotatePayload.completed). The LLM annotator is the
// proposer; this parser is the enforcer.

import { describe, it, expect } from 'vitest';
import { applyAnnotatePreconditions } from '../../packages/core/src/lifecycle/annotate-parser.js';
import type { AnnotatePayload } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function mkPayload(over: Partial<AnnotatePayload> = {}): AnnotatePayload {
  return {
    completed: true,
    message: 'task completed',
    findings: [],
    summary: 's',
    filesChanged: [],
    commitSha: null,
    ...over,
  };
}

function mkState(over: Partial<LifecycleState> & { route?: string; lastRunResult?: unknown } = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    route: 'delegate',
    ...over,
  } as unknown as LifecycleState;
}

describe('applyAnnotatePreconditions — write route', () => {
  it('passes through when worker=done, review=approved, commits present', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [{ sha: 'abc', subject: 's' }],
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(result.completed).toBe(true);
  });

  it('worker self-assess "failed" no longer blocks when objective signals agree', () => {
    const state = mkState({
      reviewVerdict: 'approved',
      commits: [{ sha: 'abc', subject: 's' }],
      lastRunResult: { workerStatus: 'failed' } as any,
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
    } as any);
    const result = applyAnnotatePreconditions({ completed: true, message: '', findings: [] } as any, state);
    expect(result.completed).toBe(true);
  });

  it('overrides to false when review=changes_required and rework did not run', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      commits: [{ sha: 'abc' }],
      reworkApplied: false,
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/review required changes/i);
  });

  it('promotes review=changes_required to done when rework cleaned up cleanly (M4)', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      reworkError: undefined,
      commits: [{ sha: 'abc' }],
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'done', status: 'ok', unaddressedFindingIds: [] },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(true);
  });

  it('overrides to false when rework leaves findings unaddressed', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      commits: [{ sha: 'abc' }],
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'done', status: 'ok', unaddressedFindingIds: ['F1', 'F2'] },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/F1, F2/);
  });

  it('missing commit gate blocks completion (write route)', () => {
    const state = mkState({
      reviewVerdict: 'approved',
      reviewPolicy: 'full',
      gates: { implement: { outcome: 'advance' }, commit: undefined },
      lastRunResult: { workerStatus: 'done' } as any,
    } as any);
    const result = applyAnnotatePreconditions({ completed: true, message: '', findings: [] } as any, state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/commit/i);
  });

  it('commit gate kind=no_op yields completed=true', () => {
    const state = mkState({
      reviewVerdict: 'approved',
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'no_op' } } },
      lastRunResult: { workerStatus: 'done' } as any,
    } as any);
    const result = applyAnnotatePreconditions({ completed: true, message: '', findings: [] } as any, state);
    expect(result.completed).toBe(true);
  });

  it('does NOT complete a write route when the commit gate is absent', () => {
    // The autoCommit override that used to let a write route complete without a
    // commit was removed; commit completion is now gated solely by commit kind.
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      gates: { implement: { outcome: 'advance' }, commit: undefined },
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
  });
});

describe('applyAnnotatePreconditions — read route', () => {
  it('passes through when worker=done and at least one criterion succeeded (M2)', () => {
    const state = mkState({
      route: 'investigate',
      reviewPolicy: 'quality_only',
      gates: { implement: { outcome: 'advance' } },
      lastRunResult: {
        workerStatus: 'done',
        status: 'ok',
        criteriaSucceeded: ['c1', 'c2'],
        criteriaErrors: [{ criterionId: 'c3', error: 'timeout' }],
      },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(true);
  });

  it('overrides to false when zero criteria succeeded', () => {
    const state = mkState({
      route: 'audit',
      gates: { implement: { outcome: 'advance' } },
      lastRunResult: {
        workerStatus: 'done',
        status: 'ok',
        criteriaSucceeded: [],
        criteriaErrors: [{ criterionId: 'c1', error: 'timeout' }],
      },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/criteria succeeded/);
  });

  it('overrides to false when implement did not advance (status=error)', () => {
    const state = mkState({
      route: 'investigate',
      lastRunResult: { workerStatus: 'done', status: 'error' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/implement did not advance/);
  });
});

describe('applyAnnotatePreconditions — recovery-message synthesis', () => {
  it('preserves an LLM-supplied recovery message when one already exists', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      commits: [{ sha: 'abc' }],
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'failed', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(
      mkPayload({ message: 'Re-dispatch with focused brief on findings F1, F2' }),
      state,
    );
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/Re-dispatch/);
  });

  it('synthesizes a generic recovery message when none is supplied', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [],
      gates: { implement: { outcome: 'advance' }, commit: undefined },
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload({ message: '' }), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/Recommend re-dispatch/);
  });
});
