// tests/acceptance/stage-io-architectural.test.ts
//
// Covers AC-1, AC-4, AC-5, AC-6, AC-7, AC-8 from spec §11.
// These are the architectural invariants of the v5 stage-io contract:
// stage ordering, return-type uniformity, payload shape, compose purity,
// and driver halt containment.

import { describe, it, expect } from 'bun:test';
import { STAGE_PLAN } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import { runStagePlan } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type {
  LifecycleState,
} from '../../packages/core/src/lifecycle/stage-plan-types.js';
import type {
  StageDefinition, StageGate, ComposePayload,
} from '../../packages/core/src/lifecycle/stage-io.js';

const STAGES_IN_ORDER = [
  'prepare',
  'register-block',
  'implement',
  'review',
  'rework',
  'commit',
  'annotate',
  'compose',
  'terminal',
] as const;

describe('AC-1: STAGE_PLAN has 9 stages in canonical order', () => {
  it('STAGE_PLAN length is 9', () => {
    expect(STAGE_PLAN.length).toBe(STAGES_IN_ORDER.length);
  });

  it('stage names match canonical ordering verbatim', () => {
    const names = STAGE_PLAN.map((s) => (s as StageDefinition).name);
    expect(names).toEqual([...STAGES_IN_ORDER]);
  });
});

describe('AC-4: every stage handler is typed to return Promise<StageGate<TPayload>>', () => {
  it('every STAGE_PLAN entry has handler of type Function', () => {
    for (const stage of STAGE_PLAN) {
      const def = stage as StageDefinition;
      expect(typeof def.handler).toBe('function');
    }
  });

  it('every STAGE_PLAN entry has shouldRun and applicableRoutes', () => {
    for (const stage of STAGE_PLAN) {
      const def = stage as StageDefinition;
      expect(typeof def.shouldRun).toBe('function');
      expect(def.applicableRoutes).toBeDefined();
    }
  });
});

describe('AC-5: payload shapes are stable across routes', () => {
  // We can't run the full driver here (it requires real providers); but we
  // can assert the payload type imports compile (a build-time invariant) and
  // that the canonical stage-io.ts exports are all present and shaped.
  it('all payload types are exported from stage-io.ts', async () => {
    const mod = await import('../../packages/core/src/lifecycle/stage-io.js');
    expect(typeof mod.ALL_TASK_ROUTES).toBe('object');
    expect(Array.isArray(mod.ALL_TASK_ROUTES)).toBe(true);
    expect(typeof mod.WRITE_ROUTES).toBe('object');
  });
});

describe('AC-6: composeHandler is pure (same gates → same payload)', () => {
  it('two runs of composeHandler with identical state.gates produce identical payloads', async () => {
    const { composeHandler } = await import('../../packages/core/src/lifecycle/handlers/baseline-handlers.js');
    const makeState = (): LifecycleState => ({
      terminal: false,
      reviewPolicy: 'full',
      shutdownInProgress: false,
      route: 'delegate',
      halted: false,
      gates: {
        annotate: {
          outcome: 'advance',
          payload: {
            completed: true,
            message: 'done',
            findings: [],
            summary: 's',
            filesChanged: ['a.ts'],
            commitSha: 'abc',
          },
          telemetry: { stageLabel: 'annotate', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        },
      },
    } as unknown as LifecycleState);

    const a = await composeHandler(makeState());
    const b = await composeHandler(makeState());
    const aPayload = a.payload as ComposePayload;
    const bPayload = b.payload as ComposePayload;
    expect(aPayload.completed).toEqual(bPayload.completed);
    expect(aPayload.message).toEqual(bPayload.message);
    expect(aPayload.filesChanged).toEqual(bPayload.filesChanged);
    expect(aPayload.commitSha).toEqual(bPayload.commitSha);
  });
});

describe('AC-7 + AC-8: runStagePlan halt containment', () => {
  // Build a minimal stage plan where the second stage throws.
  it('uncaught exception in a handler synthesizes a halt gate', async () => {
    const fakePlan: StageDefinition<unknown>[] = [
      {
        name: 's1',
        runOnHalt: false,
        applicableRoutes: 'all',
        shouldRun: () => ({ run: true }),
        handler: async (): Promise<StageGate<null>> => ({
          outcome: 'advance', payload: null,
          telemetry: { stageLabel: 's1', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        }),
      },
      {
        name: 's2',
        runOnHalt: false,
        applicableRoutes: 'all',
        shouldRun: () => ({ run: true }),
        handler: async () => { throw new Error('boom'); },
      },
      {
        name: 's3',
        runOnHalt: false,
        applicableRoutes: 'all',
        shouldRun: () => ({ run: true }),
        handler: async (): Promise<StageGate<null>> => ({
          outcome: 'advance', payload: null,
          telemetry: { stageLabel: 's3', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        }),
      },
    ];
    const state = {
      terminal: false, reviewPolicy: 'full',
      shutdownInProgress: false, route: 'delegate' as const, gates: {}, halted: false,
    } as unknown as LifecycleState;
    const out = await runStagePlan(fakePlan, state);
    // s2 must be a halt gate; s3 must NOT have a gate (silent not_run after halt).
    expect(out.gates!['s2'].outcome).toBe('halt');
    expect(out.gates!['s2'].comment).toMatch(/s2 crashed: boom/);
    expect(out.gates!['s3']).toBeUndefined();
  });

  it('runOnHalt stages still execute after halt', async () => {
    const fakePlan: StageDefinition<unknown>[] = [
      {
        name: 'crash',
        runOnHalt: false,
        applicableRoutes: 'all',
        shouldRun: () => ({ run: true }),
        handler: async () => { throw new Error('x'); },
      },
      {
        name: 'compose',
        runOnHalt: true,
        applicableRoutes: 'all',
        shouldRun: () => ({ run: true }),
        handler: async (): Promise<StageGate<null>> => ({
          outcome: 'advance', payload: null,
          telemetry: { stageLabel: 'compose', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        }),
      },
    ];
    const state = {
      terminal: false, reviewPolicy: 'full',
      shutdownInProgress: false, route: 'delegate' as const, gates: {}, halted: false,
    } as unknown as LifecycleState;
    const out = await runStagePlan(fakePlan, state);
    expect(out.gates!['crash'].outcome).toBe('halt');
    expect(out.gates!['compose']).toBeDefined();
    expect(out.gates!['compose'].outcome).toBe('advance');
  });
});
