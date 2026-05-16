import type { WorkerStatus, VerifyOutcome } from '../types.js';
export type { WorkerStatus, VerifyOutcome };
export type OverallReviewVerdict = 'approved' | 'concerns' | 'annotated' | 'not_applicable';
export type ArtifactsCheck = 'pass' | 'fail' | 'not_applicable';
export type TerminalStatus = 'ok' | 'incomplete' | 'timeout' | 'error' | 'brief_too_vague' | 'unavailable';

export interface TerminalInputs {
  shutdownInProgress: boolean;
  workerStatus: WorkerStatus;
  overallReviewVerdict: OverallReviewVerdict;
  artifactsCheck: ArtifactsCheck;
  verifyOutcome: VerifyOutcome;
  guardFires: string[];
  errorCode: string | null;
}

export interface TerminalDecision {
  terminalStatus: TerminalStatus;
  errorCode: string | null;
}

export class TerminalStatusDeriver {
  derive(inputs: TerminalInputs): TerminalDecision {
    // 1. shutdown
    if (inputs.shutdownInProgress) return { terminalStatus: 'unavailable', errorCode: inputs.errorCode };
    // 2. time / idle
    if (inputs.guardFires.includes('guard_time_ceiling') || inputs.guardFires.includes('guard_idle_timeout')) {
      return { terminalStatus: 'timeout', errorCode: inputs.errorCode };
    }
    // 4. provider / runner errors after escalation
    if (inputs.errorCode && (inputs.errorCode.startsWith('provider_') || inputs.errorCode.startsWith('runner_'))) {
      return { terminalStatus: 'error', errorCode: inputs.errorCode };
    }
    // 5. lifecycle review loop capped
    if (inputs.errorCode === 'lifecycle_review_loop_capped') return { terminalStatus: 'incomplete', errorCode: inputs.errorCode };
    // 6. brief invalid
    if (inputs.errorCode === 'intake_brief_invalid') return { terminalStatus: 'brief_too_vague', errorCode: inputs.errorCode };
    // 7. artifacts missing
    if (inputs.artifactsCheck === 'fail') return { terminalStatus: 'incomplete', errorCode: 'validator_no_artifacts' };
    // 8. verify command failed
    if (inputs.verifyOutcome === 'failed') return { terminalStatus: 'error', errorCode: 'validator_verify_command_failed' };
    // 9. happy path
    const reviewOk = ['approved', 'concerns', 'annotated', 'not_applicable'].includes(inputs.overallReviewVerdict);
    const workerOk = inputs.workerStatus === 'done' || inputs.workerStatus === 'done_with_concerns';
    if (reviewOk && workerOk) return { terminalStatus: 'ok', errorCode: null };
    // 10. fallback
    return { terminalStatus: 'incomplete', errorCode: inputs.errorCode ?? 'validator_silent_incomplete' };
  }
}
