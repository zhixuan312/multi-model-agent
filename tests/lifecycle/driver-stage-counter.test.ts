import { describe, it, expect } from 'vitest';
import { runStagePlan } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { StageDefinition, StageGate, RouteName } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

interface RecordedTransition {
  stage: string;
  stageIndex: number;
  stageCount: number;
  reviewRound?: number;
  attemptCap?: number;
}

function makeStubHeartbeat() {
  const calls: RecordedTransition[] = [];
  return {
    transition: (fields: Record<string, unknown>) => {
      calls.push({
        stage: String(fields.stage),
        stageIndex: Number(fields.stageIndex),
        stageCount: Number(fields.stageCount),
        ...(fields.reviewRound !== undefined && { reviewRound: Number(fields.reviewRound) }),
        ...(fields.attemptCap !== undefined && { attemptCap: Number(fields.attemptCap) }),
      });
    },
    calls,
  };
}

function makeStage(name: string, opts: { applicableRoutes?: 'all' | RouteName[]; shouldRun?: (s: LifecycleState) => { run: true } | { run: false; comment: string }; runOnHalt?: boolean } = {}): StageDefinition<unknown> {
  return {
    name,
    runOnHalt: opts.runOnHalt ?? false,
    applicableRoutes: opts.applicableRoutes ?? 'all',
    shouldRun: opts.shouldRun ?? (() => ({ run: true })),
    handler: async () => ({
      outcome: 'advance',
      payload: null,
      telemetry: { stageLabel: name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    }) as StageGate<unknown>,
  };
}

describe('lifecycle driver — visible-stage counter', () => {
  it('fires transitions only for visible stages, with monotonic stageIndex', async () => {
    const hb = makeStubHeartbeat();
    const plan: StageDefinition<unknown>[] = [
      makeStage('prepare'),
      makeStage('implement'),
      makeStage('review', { applicableRoutes: ['delegate'] }),
      makeStage('rework', { applicableRoutes: ['delegate'] }),
      makeStage('commit', { applicableRoutes: ['delegate'] }),
      makeStage('annotate'),
      makeStage('compose', { runOnHalt: true }),
      makeStage('terminal', { runOnHalt: true }),
    ];
    const state: LifecycleState = {
      route: 'delegate',
      executionContext: { heartbeat: hb },
      gates: {},
      halted: false,
    } as LifecycleState;

    await runStagePlan(plan, state);

    // Only the five visible stages fire transitions.
    expect(hb.calls.map((c) => c.stage)).toEqual([
      'implementing', 'review', 'rework', 'committing', 'annotating',
    ]);
    // stageIndex monotonic, stageCount stable at 5.
    expect(hb.calls.map((c) => c.stageIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(hb.calls.map((c) => c.stageCount)).toEqual([5, 5, 5, 5, 5]);
    // review/rework include the required round fields.
    expect(hb.calls[1].reviewRound).toBe(1);
    expect(hb.calls[1].attemptCap).toBe(1);
    expect(hb.calls[2].reviewRound).toBe(1);
    expect(hb.calls[2].attemptCap).toBe(1);
  });

  it('decrements stageCount when a visible stage is skipped by shouldRun', async () => {
    const hb = makeStubHeartbeat();
    const plan: StageDefinition<unknown>[] = [
      makeStage('prepare'),
      makeStage('implement'),
      makeStage('review', { applicableRoutes: ['delegate'], shouldRun: () => ({ run: false, comment: 'reviewPolicy=none' }) }),
      makeStage('rework', { applicableRoutes: ['delegate'], shouldRun: () => ({ run: false, comment: 'no verdict' }) }),
      makeStage('commit', { applicableRoutes: ['delegate'], shouldRun: () => ({ run: false, comment: 'no files' }) }),
      makeStage('annotate'),
      makeStage('compose', { runOnHalt: true }),
      makeStage('terminal', { runOnHalt: true }),
    ];
    const state: LifecycleState = {
      route: 'delegate',
      executionContext: { heartbeat: hb },
      gates: {},
      halted: false,
    } as LifecycleState;

    await runStagePlan(plan, state);

    // Only implement + annotate fire. Three visible skips were observed before
    // annotate ran, so stageCount converges to 2 by the time annotate transitions.
    expect(hb.calls.map((c) => c.stage)).toEqual(['implementing', 'annotating']);
    expect(hb.calls.map((c) => c.stageIndex)).toEqual([1, 2]);
    // First transition: visibleTotal was 5 (no skips seen yet at implement).
    expect(hb.calls[0].stageCount).toBe(5);
    // Second transition: review+rework+commit have all been skipped → total = 2.
    expect(hb.calls[1].stageCount).toBe(2);
  });

  it('skips visible-stage transition when applicableRoutes excludes the current route', async () => {
    const hb = makeStubHeartbeat();
    // 'debug' is a read-only route — review/rework/commit don't apply.
    const plan: StageDefinition<unknown>[] = [
      makeStage('prepare'),
      makeStage('implement'),
      makeStage('review', { applicableRoutes: ['delegate'] }),
      makeStage('rework', { applicableRoutes: ['delegate'] }),
      makeStage('commit', { applicableRoutes: ['delegate'] }),
      makeStage('annotate'),
    ];
    const state: LifecycleState = {
      route: 'debug',
      executionContext: { heartbeat: hb },
      gates: {},
      halted: false,
    } as LifecycleState;

    await runStagePlan(plan, state);

    // Read-only: only implement + annotate are visible.
    expect(hb.calls.map((c) => c.stage)).toEqual(['implementing', 'annotating']);
    expect(hb.calls.map((c) => c.stageIndex)).toEqual([1, 2]);
    expect(hb.calls.map((c) => c.stageCount)).toEqual([2, 2]);
  });

  it('does not crash when state.executionContext.heartbeat is absent', async () => {
    const plan: StageDefinition<unknown>[] = [
      makeStage('implement'),
      makeStage('annotate'),
    ];
    const state: LifecycleState = {
      route: 'delegate',
      executionContext: {},
      gates: {},
      halted: false,
    } as LifecycleState;

    await expect(runStagePlan(plan, state)).resolves.toBeDefined();
  });
});
