import type { WorkerStatus } from '../types.js';
export type { WorkerStatus };
export type OverallReviewVerdict = 'approved' | 'concerns' | 'annotated' | 'not_applicable';
export type ArtifactsCheck = 'pass' | 'fail' | 'not_applicable';
export type TerminalStatus = 'ok' | 'incomplete' | 'timeout' | 'error' | 'brief_too_vague' | 'unavailable';

export interface TerminalInputs {
  shutdownInProgress: boolean;
  workerStatus: WorkerStatus;
  overallReviewVerdict: OverallReviewVerdict;
  artifactsCheck: ArtifactsCheck;
  guardFires: string[];
  errorCode: string | null;
}

export interface TerminalDecision {
  terminalStatus: TerminalStatus;
  errorCode: string | null;
}

const TIMEOUT_CODES = new Set(['wall_clock_exceeded', 'aborted', 'guard_time_ceiling', 'guard_idle_timeout']);
const ERROR_CODES = new Set(['sdk_max_turns', 'sdk_max_budget', 'sdk_execution_error', 'sdk_max_structured_output_retries', 'codex_error', 'codex_not_installed', 'spawn_failed', 'turn_failed']);

export class TerminalStatusDeriver {
  derive(inputs: TerminalInputs): TerminalDecision {
    if (inputs.shutdownInProgress) return { terminalStatus: 'unavailable', errorCode: inputs.errorCode };

    if (inputs.guardFires.some(g => TIMEOUT_CODES.has(g))) {
      return { terminalStatus: 'timeout', errorCode: inputs.errorCode };
    }

    if (inputs.errorCode && TIMEOUT_CODES.has(inputs.errorCode)) {
      return { terminalStatus: 'timeout', errorCode: inputs.errorCode };
    }

    if (inputs.errorCode && (ERROR_CODES.has(inputs.errorCode) || inputs.errorCode.startsWith('exit_'))) {
      return { terminalStatus: 'error', errorCode: inputs.errorCode };
    }

    if (inputs.artifactsCheck === 'fail') return { terminalStatus: 'incomplete', errorCode: 'validator_no_artifacts' };

    const reviewOk = ['approved', 'concerns', 'annotated', 'not_applicable'].includes(inputs.overallReviewVerdict);
    const workerOk = inputs.workerStatus === 'done' || inputs.workerStatus === 'done_with_concerns';
    if (reviewOk && workerOk) return { terminalStatus: 'ok', errorCode: null };

    return { terminalStatus: 'incomplete', errorCode: inputs.errorCode ?? 'validator_silent_incomplete' };
  }
}
