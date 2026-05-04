import { describe, it, expect } from 'vitest';
import { DeriveTerminalStatusHandler } from '../../packages/core/src/lifecycle/handlers/derive-terminal-status.js';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';
import { ShutdownCoordinator } from '../../packages/core/src/lifecycle/sweepers/shutdown-coordinator.js';

describe('shutdown wire', () => {
  it('coordinator.signal() makes terminalStatus=unavailable', () => {
    const coord = new ShutdownCoordinator();
    coord.signal();
    const handler = new DeriveTerminalStatusHandler(new TerminalStatusDeriver(), coord);
    const state: any = {
      terminal: false,
      attemptIndex: 0,
      attemptBudget: 7,
      reviewPolicy: 'full',
      workerStatus: 'done',
      reviewVerdict: 'approved',
    };
    handler.handler(state);
    expect(state.terminalStatus).toBe('unavailable');
  });

  it('without shutdown signal, happy path produces ok', () => {
    const coord = new ShutdownCoordinator();
    const handler = new DeriveTerminalStatusHandler(new TerminalStatusDeriver(), coord);
    const state: any = {
      terminal: false,
      attemptIndex: 0,
      attemptBudget: 7,
      reviewPolicy: 'full',
      workerStatus: 'done',
      reviewVerdict: 'approved',
    };
    handler.handler(state);
    expect(state.terminalStatus).toBe('ok');
  });
});
