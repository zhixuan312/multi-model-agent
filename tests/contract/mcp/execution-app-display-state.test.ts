import { describe, it, expect } from 'vitest';
import { deriveDisplayState } from '../../../packages/server/src/ui/execution/display-state.js';

const running = { taskId: 't1', status: 'running' as const, phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, startedAt: '2026-01-01T00:00:00.000Z' };
const terminal = { task: { taskId: 't1', status: 'done' }, metrics: { totalCostUsd: 1.23, savedVsMainCostUsd: 4.56 }, output: { summary: { ok: true } } };

describe('contract: execution App display-state derivation (pure)', () => {
  it('renders phase/elapsed/phaseElapsed for a running snapshot with no optional fields present', () => {
    expect(deriveDisplayState(running)).toEqual({ mode: 'running', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000 });
  });

  it('renders runningHeadline and totalTasks only when present, never a placeholder when absent', () => {
    const withExtras = { ...running, runningHeadline: 'writing tests', totalTasks: 5 };
    expect(deriveDisplayState(withExtras)).toEqual({ mode: 'running', phase: 'execute', elapsedMs: 4000, phaseElapsedMs: 1000, runningHeadline: 'writing tests', totalTasks: 5 });
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