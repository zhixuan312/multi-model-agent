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
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(result.completed).toBe(true);
  });

  it('overrides to false when worker self-assessed failed', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [{ sha: 'abc' }],
      lastRunResult: { workerStatus: 'failed', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/worker self-assessed as failed/);
  });

  it('overrides to false when review=changes_required and rework did not run', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      commits: [{ sha: 'abc' }],
      reworkApplied: false,
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
      lastRunResult: { workerStatus: 'done', status: 'ok', unaddressedFindingIds: ['F1', 'F2'] },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/F1, F2/);
  });

  it('overrides to false when no commit landed and no clean no_op reason', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [],
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(false);
    expect(result.message).toMatch(/no commit landed/);
  });

  it('completes when autoCommit=false explains the absent commit', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [],
      autoCommit: false,
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload(), state);
    expect(result.completed).toBe(true);
  });
});

describe('applyAnnotatePreconditions — read route', () => {
  it('passes through when worker=done and at least one criterion succeeded (M2)', () => {
    const state = mkState({
      route: 'investigate',
      reviewPolicy: 'quality_only',
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
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    } as Partial<LifecycleState>);
    const result = applyAnnotatePreconditions(mkPayload({ message: '' }), state);
    expect(result.message).toMatch(/Recommend re-dispatch/);
  });
});
