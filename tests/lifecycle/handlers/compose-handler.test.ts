// tests/lifecycle/handlers/compose-handler.test.ts
//
// Plan task 28 referenced — direct unit tests for the four composeHandler
// paths per spec §5.8: (1) normal, (2) register-context-block, (3) halt,
// (4) internal_state_corrupted.
//
// composeHandler is pure: it reads state.gates / state.route / state.halted
// and produces a StageGate<ComposePayload>. Each path is exercised in
// isolation here; observability cross-checks live in
// tests/acceptance/stage-io-compose.test.ts.

import { describe, it, expect } from 'bun:test';
import { composeHandler } from '../../../packages/core/src/lifecycle/handlers/baseline-handlers.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type {
  StageGate, AnnotatePayload, ComposePayload, RegisterBlockPayload,
} from '../../../packages/core/src/lifecycle/stage-io.js';

function advance<T>(payload: T, stage = ''): StageGate<T> {
  return {
    outcome: 'advance',
    payload,
    telemetry: { stageLabel: stage, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
  };
}
function halt(stage: string, comment: string): StageGate<null> {
  return {
    outcome: 'halt',
    payload: null,
    comment,
    telemetry: { stageLabel: stage, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
  };
}

function mkState(over: Partial<LifecycleState> & Record<string, unknown> = {}): LifecycleState {
  return {
    terminal: false,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    route: 'delegate',
    halted: false,
    gates: {},
    ...over,
  } as unknown as LifecycleState;
}

describe('composeHandler — Path 1: normal (annotate advanced)', () => {
  it('lifts AnnotatePayload fields and sets blockId=null for write routes', async () => {
    const ap: AnnotatePayload = {
      completed: true,
      message: 'all good',
      findings: [],
      summary: 's',
      filesChanged: ['a.ts'],
      commitSha: 'abc',
    };
    const state = mkState({
      route: 'delegate',
      gates: { annotate: advance(ap, 'annotate') },
    });
    const gate = await composeHandler(state);
    const p = gate.payload as ComposePayload;
    expect(gate.outcome).toBe('advance');
    expect(p.completed).toBe(true);
    expect(p.message).toBe('all good');
    expect(p.commitSha).toBe('abc');
    expect(p.blockId).toBeNull();
    expect(p.telemetry).toBeDefined();
  });

  it('propagates completed=false from annotator', async () => {
    const ap: AnnotatePayload = {
      completed: false,
      message: 'task did not complete: review required changes',
      findings: [{ id: 'F1', severity: 'high', claim: 'x' }],
      summary: 's',
      filesChanged: [],
      commitSha: null,
    };
    const state = mkState({
      gates: { annotate: advance(ap, 'annotate') },
    });
    const gate = await composeHandler(state);
    expect((gate.payload as ComposePayload).completed).toBe(false);
    expect((gate.payload as ComposePayload).findings).toHaveLength(1);
  });
});

describe('composeHandler — Path 2: register-context-block synthesis', () => {
  it('returns completed=true with the registered blockId when the register-block gate advanced', async () => {
    const rb: RegisterBlockPayload = { blockId: 'cb-xyz', bytes: 1024 };
    const state = mkState({
      route: 'register-context-block',
      gates: { 'register-block': advance(rb, 'register-block') },
    });
    const gate = await composeHandler(state);
    const p = gate.payload as ComposePayload;
    expect(p.completed).toBe(true);
    expect(p.blockId).toBe('cb-xyz');
    expect(p.message).toMatch(/cb-xyz/);
    expect(p.message).toMatch(/1024 bytes/);
  });

  it('returns completed=false when block-registration halted', async () => {
    const state = mkState({
      route: 'register-context-block',
      gates: { 'register-block': halt('register-block', 'quota_exceeded') },
    });
    const gate = await composeHandler(state);
    const p = gate.payload as ComposePayload;
    expect(p.completed).toBe(false);
    expect(p.blockId).toBeNull();
    expect(p.message).toMatch(/quota_exceeded/);
  });
});

describe('composeHandler — Path 3: pre-annotate halt', () => {
  it('synthesizes a halted payload naming the halted stage', async () => {
    const state = mkState({
      halted: true,
      gates: { implement: halt('implement', 'transport timeout') },
    });
    const gate = await composeHandler(state);
    const p = gate.payload as ComposePayload;
    expect(p.completed).toBe(false);
    expect(p.message).toMatch(/implement halted/);
    expect(p.message).toMatch(/transport timeout/);
  });
});

describe('composeHandler — Path 4: internal_state_corrupted fallback', () => {
  it('emits a degenerate payload when no gate advanced AND not halted', async () => {
    const state = mkState({ halted: false, gates: {} });
    const gate = await composeHandler(state);
    const p = gate.payload as ComposePayload;
    expect(p.completed).toBe(false);
    expect(p.message).toBe('internal_state_corrupted');
    expect(p.telemetry.stopReason).toBe('transport_error');
    expect(p.telemetry.totalCostUSD).toBeNull();
  });
});
