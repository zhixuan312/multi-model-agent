// tests/acceptance/stage-io-compose.test.ts — AC-21, AC-22
import { describe, it, expect } from 'vitest';
import type { ComposePayload } from '../../packages/core/src/lifecycle/stage-io.js';
import { composeHandler } from '../../packages/core/src/lifecycle/handlers/baseline-handlers.js';
import { mockState, advanceGate, haltGate } from '../fixtures/lifecycle-state.js';

const NINE_STAGE_NAMES = [
  'prepare', 'register-block', 'implement', 'review', 'rework',
  'commit', 'annotate', 'compose', 'terminal',
];

// Shared shape assertions for all four compose paths.
function assertStages9(telemetry: ComposePayload['telemetry']) {
  expect(telemetry.stages).toHaveLength(9);
  expect(telemetry.stages.map(s => s.name)).toEqual(NINE_STAGE_NAMES);
  for (const stage of telemetry.stages) {
    expect(typeof stage.durationMs).toBe('number');
    expect(typeof stage.outcome).toBe('string');
  }
}

describe('AC-21: compose covers four paths', () => {
  it('normal path: annotate.payload is copied verbatim', async () => {
    const state = mockState({ route: 'delegate' });
    state.gates['annotate'] = advanceGate({
      completed: true, message: 'ok', findings: [], summary: 's',
      filesChanged: ['x.ts'], commitSha: null,
    });
    const out = await composeHandler(state);
    const p = out.payload as ComposePayload;
    expect(p.completed).toBe(true);
    expect(p.message).toBe('ok');
    expect(p.findings).toEqual([]);
    expect(p.summary).toBe('s');
    expect(p.filesChanged).toEqual(['x.ts']);
    expect(p.commitSha).toBeNull();
    expect(p.blockId).toBeNull();
    expect(p.telemetry.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(p.telemetry.totalCostUSD).toBe(0);
    expect(p.telemetry.workerSelfAssessment).toBeNull();
    expect(p.telemetry.reviewVerdict).toBeNull();
    expect(p.telemetry.commitOutcome).toBe('not_applicable');
    expect(p.telemetry.stopReason).toBe('normal');
    expect(p.telemetry.haltedStage).toBeNull();
    assertStages9(p.telemetry);
  });

  it('register-block path', async () => {
    const state = mockState({ route: 'register-context-block' });
    state.gates['register-block'] = advanceGate({ blockId: 'cb-1', bytes: 12 });
    const out = await composeHandler(state);
    const p = out.payload as ComposePayload;
    expect(p.completed).toBe(true);
    expect(p.message).toContain('cb-1');
    expect(p.blockId).toBe('cb-1');
    expect(p.findings).toEqual([]);
    expect(p.summary).toBe('');
    expect(p.filesChanged).toEqual([]);
    expect(p.commitSha).toBeNull();
    expect(p.telemetry.commitOutcome).toBe('not_applicable');
    expect(p.telemetry.stopReason).toBe('normal');
    expect(p.telemetry.haltedStage).toBeNull();
    expect(p.telemetry.stages).toHaveLength(9);
  });

  it('pre-annotate halt path', async () => {
    const state = mockState({ route: 'delegate', halted: true });
    state.gates['implement'] = haltGate('provider down');
    const out = await composeHandler(state);
    const p = out.payload as ComposePayload;
    expect(p.completed).toBe(false);
    expect(p.message).toMatch(/implement halted/);
    expect(p.message).toMatch(/provider down/);
    expect(Array.isArray(p.findings)).toBe(true);    // review findings preferred; fallback is implement findings
    expect(p.summary).toBe('');
    expect(p.filesChanged).toEqual([]);
    expect(p.commitSha).toBeNull();
    expect(p.blockId).toBeNull();
    expect(p.telemetry.stopReason).toBe('transport_error');
    expect(p.telemetry.haltedStage).toBe('implement');
    assertStages9(p.telemetry);
  });

  it('internal_state_corrupted degenerate fallback', async () => {
    const state = mockState({ route: 'delegate' });   // no annotate, not halted
    const out = await composeHandler(state);
    const p = out.payload as ComposePayload;
    expect(p.completed).toBe(false);
    expect(p.message).toBe('internal_state_corrupted');
    expect(p.findings).toEqual([]);
    expect(p.summary).toBe('');
    expect(p.filesChanged).toEqual([]);
    expect(p.commitSha).toBeNull();
    expect(p.blockId).toBeNull();
    expect(p.telemetry.totalDurationMs).toBe(0);
    expect(p.telemetry.totalCostUSD).toBeNull();
    expect(p.telemetry.workerSelfAssessment).toBeNull();
    expect(p.telemetry.reviewVerdict).toBeNull();
    expect(p.telemetry.commitOutcome).toBe('not_applicable');
    expect(p.telemetry.stopReason).toBe('transport_error');
    expect(p.telemetry.haltedStage).toBeNull();
    expect(p.telemetry.stages).toHaveLength(9);
    // Canonical not_run entries use costUSD: 0 (not null)
    for (const stage of p.telemetry.stages) {
      expect(stage.outcome).toBe('not_run');
      expect(stage.costUSD).toBe(0);
    }
  });
});

describe('AC-22: telemetry.stages has 9 entries always', () => {
  it('returns exactly 9 stages regardless of gates present', async () => {
    const state = mockState({ route: 'delegate' });
    state.gates['annotate'] = advanceGate({
      completed: true, message: 'ok', findings: [], summary: 's',
      filesChanged: [], commitSha: null,
    });
    const out = await composeHandler(state);
    expect((out.payload as any).telemetry.stages).toHaveLength(9);
  });
});