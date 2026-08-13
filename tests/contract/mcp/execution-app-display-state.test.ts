import { describe, it, expect } from 'vitest';
import { deriveDisplayState } from '../../../packages/server/src/ui/execution/display-state.js';

const running = { executionId: 't1', type: 'spec', status: 'running' as const, phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, startedAt: '2026-01-01T00:00:00.000Z' };
const terminal = { execution: { executionId: 't1', type: 'spec', status: 'done' }, metrics: { totalCostUsd: 1.23, savedVsMainCostUsd: 4.56 }, output: { summary: { ok: true } } };

describe('contract: execution App display-state derivation (pure)', () => {
  it('renders phase/elapsed/phaseElapsed for a running snapshot with no optional fields present', () => {
    expect(deriveDisplayState(running)).toEqual({ mode: 'running', taskType: 'spec', type: 'spec', taskRef: 't1', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000 });
  });

  it('renders runningHeadline and totalTasks only when present, never a placeholder when absent', () => {
    const withExtras = { ...running, runningHeadline: 'writing tests', totalTasks: 5 };
    expect(deriveDisplayState(withExtras)).toEqual({ mode: 'running', taskType: 'spec', type: 'spec', taskRef: 't1', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, runningHeadline: 'writing tests', totalTasks: 5 });
    const state = deriveDisplayState(running) as Record<string, unknown>;
    expect(state).not.toHaveProperty('runningHeadline');
    expect(state).not.toHaveProperty('totalTasks');
  });

  it('renders cancelling — not terminal — when cancellationRequested is true', () => {
    const state = deriveDisplayState({ ...running, cancellationRequested: true as const });
    expect(state.mode).toBe('cancelling');
  });

  it('derives run STATS from a terminal envelope, and never the result text', () => {
    // The conversation carries the full answer directly below the panel, so `output.summary`
    // is deliberately not part of the display state at all.
    const state = deriveDisplayState(terminal) as Record<string, unknown>;
    expect(state).toEqual({ mode: 'terminal', taskType: 'spec', type: 'spec', taskRef: 't1', status: 'done', ending: 'done', totalCostUsd: 1.23, savedVsMainCostUsd: 4.56 });
    expect(state).not.toHaveProperty('summary');
  });
});

/**
 * `Running` / `implementing` reads identically for all twelve task types, so the panel
 * used to say nothing about WHICH task it was showing. The type is the first thing the
 * heading needs.
 */
describe('contract: task type on the execution panel', () => {
  it('surfaces the type on running, cancelling and terminal states alike', () => {
    expect(deriveDisplayState(running)).toMatchObject({ mode: 'running', taskType: 'spec' });
    expect(deriveDisplayState({ ...running, cancellationRequested: true }))
      .toMatchObject({ mode: 'cancelling', taskType: 'spec' });
    expect(deriveDisplayState(terminal)).toMatchObject({ mode: 'terminal', taskType: 'spec' });
  });

  it("qualifies an audit with its criteria set — 'audit (plan)' is not 'audit (spec)'", () => {
    expect(deriveDisplayState({ ...running, type: 'audit', subtype: 'plan' }))
      .toMatchObject({ taskType: 'audit (plan)' });
    expect(deriveDisplayState({ execution: { executionId: 't1', type: 'audit', subtype: 'spec', status: 'done' } }))
      .toMatchObject({ taskType: 'audit (spec)' });
  });

  it('omits it entirely rather than printing a placeholder when the payload carries no type', () => {
    const { type: _omitted, ...noType } = running;
    expect(deriveDisplayState(noType)).not.toHaveProperty('taskType');
    expect(deriveDisplayState({ execution: { executionId: 't1', status: 'done' } })).not.toHaveProperty('taskType');
  });
});
/**
 * The execution reference exists to settle a question that otherwise costs a database query:
 * when two panels appear on screen, are they one execution the host rendered twice, or two
 * dispatches? Same ref answers it at a glance.
 */
describe('contract: task reference on running snapshots', () => {
  it('surfaces a short task ref on running and cancelling states', () => {
    const s = deriveDisplayState({ ...running, executionId: '8c0b7782-1234-4000-8000-abcdefabcdef' });
    expect(s).toMatchObject({ mode: 'running', taskRef: '8c0b7782' });
    const c = deriveDisplayState({
      ...running, executionId: '8c0b7782-1234-4000-8000-abcdefabcdef', cancellationRequested: true,
    });
    expect(c).toMatchObject({ mode: 'cancelling', taskRef: '8c0b7782' });
  });

  it('omits it entirely when the snapshot carries no executionId', () => {
    const { executionId: _omitted, ...noId } = running;
    expect(deriveDisplayState(noId)).not.toHaveProperty('taskRef');
  });
});
