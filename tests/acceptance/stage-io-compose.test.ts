// tests/acceptance/stage-io-compose.test.ts — AC-21, AC-22
import { describe, it, expect } from 'vitest';
import { composeHandler } from '../../packages/core/src/lifecycle/handlers/baseline-handlers.js';
import { mockState, advanceGate, haltGate } from '../fixtures/lifecycle-state.js';

describe('AC-21: compose covers four paths', () => {
  it('normal path: annotate.payload is copied verbatim', async () => {
    const state = mockState({ route: 'delegate' });
    state.gates['annotate'] = advanceGate({ completed: true, message: 'ok', findings: [], summary: '', filesChanged: [], commitSha: null });
    const out = await composeHandler(state);
    expect((out.payload as any).completed).toBe(true);
  });
  it('register-block path', async () => {
    const state = mockState({ route: 'register-context-block' });
    state.gates['register-block'] = advanceGate({ blockId: 'cb-1', bytes: 12 });
    const out = await composeHandler(state);
    expect((out.payload as any).blockId).toBe('cb-1');
  });
  it('pre-annotate halt path', async () => {
    const state = mockState({ route: 'delegate', halted: true });
    state.gates['implement'] = haltGate('provider down');
    const out = await composeHandler(state);
    expect((out.payload as any).completed).toBe(false);
    expect((out.payload as any).message).toMatch(/implement halted/);
  });
  it('internal_state_corrupted degenerate fallback', async () => {
    const state = mockState({ route: 'delegate' });   // no annotate, not halted
    const out = await composeHandler(state);
    expect((out.payload as any).message).toBe('internal_state_corrupted');
  });
});

describe('AC-22: telemetry.stages has 9 entries always', () => {
  it('returns exactly 9 stages regardless of gates present', async () => {
    const state = mockState({ route: 'delegate' });
    state.gates['annotate'] = advanceGate({ completed: true, message: 'ok', findings: [], summary: '', filesChanged: [], commitSha: null });
    const out = await composeHandler(state);
    expect((out.payload as any).telemetry.stages).toHaveLength(9);
  });
});