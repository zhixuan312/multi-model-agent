import type { LifecycleState } from '../stage-plan-types.js';
import type { TerminalStatusDeriver, TerminalInputs, WorkerStatus, OverallReviewVerdict, ArtifactsCheck, VerifyOutcome } from '../../reporting/terminal-status-deriver.js';
import type { ShutdownCoordinator } from '../sweepers/shutdown-coordinator.js';

export class DeriveTerminalStatusHandler {
  constructor(private deriver: TerminalStatusDeriver, private coordinator: ShutdownCoordinator) {}

  handler = (state: LifecycleState): void => {
    const inputs: TerminalInputs = {
      shutdownInProgress: this.coordinator.isShutdownInProgress(),
      workerStatus: (state.workerStatus as WorkerStatus) || 'done',
      overallReviewVerdict: (state.reviewVerdict as OverallReviewVerdict) || 'not_applicable',
      artifactsCheck: (state.artifactsCheck as ArtifactsCheck) || 'not_applicable',
      verifyOutcome: (state.verifyOutcome as VerifyOutcome) || 'not_applicable',
      guardFires: (state.guardFires as string[]) || [],
      errorCode: (state.errorCode as string) || null,
    };
    const decision = this.deriver.derive(inputs);
    state.terminalStatus = decision.terminalStatus;
    state.terminationReason = decision.errorCode;
    // CRITICAL: do NOT set state.terminal=true here. This handler is wired as
    // the compose_response row (5.3); rows 5.3.5 (register_terminal_block),
    // 5.4 (emit_task_terminal), 5.5 (persist_to_batch_registry), and 6.1
    // (flush_telemetry) MUST still fire after this handler runs. The
    // LifecycleDriver short-circuits on state.terminal === true, so setting
    // it here would prevent terminal-block registration, telemetry flush, and
    // batch persistence — silently breaking every task's tail.
    //
    // terminalStatus is the system-verdict field (caller-facing); terminal
    // is the lifecycle-driver short-circuit flag — they are different things.
    // Only error-path handlers (intake errors, guard fires) set
    // state.terminal = true to skip the rest of the lifecycle.
  };
}
