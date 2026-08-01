import { describe, it, expect } from 'vitest';
import { deriveDisplayState } from '../../../packages/server/src/ui/execution/display-state.js';

const running = { taskId: 't1', status: 'running' as const, phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, startedAt: '2026-01-01T00:00:00.000Z' };
const terminal = { task: { taskId: 't1', status: 'done' }, metrics: { totalCostUsd: 1.23, savedVsMainCostUsd: 4.56 }, output: { summary: { ok: true } } };

describe('contract: execution App display-state derivation (pure)', () => {
  it('renders phase/elapsed/phaseElapsed for a running snapshot with no optional fields present', () => {
    expect(deriveDisplayState(running)).toEqual({ mode: 'running', taskRef: 't1', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000 });
  });

  it('renders runningHeadline and totalTasks only when present, never a placeholder when absent', () => {
    const withExtras = { ...running, runningHeadline: 'writing tests', totalTasks: 5 };
    expect(deriveDisplayState(withExtras)).toEqual({ mode: 'running', taskRef: 't1', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, runningHeadline: 'writing tests', totalTasks: 5 });
    const state = deriveDisplayState(running) as Record<string, unknown>;
    expect(state).not.toHaveProperty('runningHeadline');
    expect(state).not.toHaveProperty('totalTasks');
  });

  it('renders cancelling — not terminal — when cancellationRequested is true', () => {
    const state = deriveDisplayState({ ...running, cancellationRequested: true as const });
    expect(state.mode).toBe('cancelling');
  });

  it('renders task.status, both cost fields, and output.summary for a terminal envelope', () => {
    expect(deriveDisplayState(terminal)).toEqual({ mode: 'terminal', status: 'done', totalCostUsd: 1.23, savedVsMainCostUsd: 4.56, summary: { ok: true } });
  });
});
/**
 * The task reference exists to settle a question that otherwise costs a database query:
 * when two panels appear on screen, are they one task the host rendered twice, or two
 * dispatches? Same ref answers it at a glance.
 */
describe('contract: task reference on running snapshots', () => {
  it('surfaces a short task ref on running and cancelling states', () => {
    const s = deriveDisplayState({ ...running, taskId: '8c0b7782-1234-4000-8000-abcdefabcdef' });
    expect(s).toMatchObject({ mode: 'running', taskRef: '8c0b7782' });
    const c = deriveDisplayState({
      ...running, taskId: '8c0b7782-1234-4000-8000-abcdefabcdef', cancellationRequested: true,
    });
    expect(c).toMatchObject({ mode: 'cancelling', taskRef: '8c0b7782' });
  });

  it('omits it entirely when the snapshot carries no taskId', () => {
    const { taskId: _omitted, ...noId } = running;
    expect(deriveDisplayState(noId)).not.toHaveProperty('taskRef');
  });
});
