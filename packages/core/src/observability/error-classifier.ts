import type { ErrorCode } from '../error-codes.js';

const STRUCTURED_CODE_TO_ERRORCODE: Record<string, ErrorCode> = {
  'dirty_worktree': 'validator_dirty_worktree',
  'verify_command_error': 'validator_verify_command_failed',
  'silent_incomplete': 'validator_silent_incomplete',
  'incomplete_no_summary': 'validator_silent_incomplete',
  'network_error': 'provider_transport_failure',
  'api_error': 'provider_api_error',
  'api_aborted': 'provider_api_aborted',
  'timeout': 'provider_timeout',
  'rate_limit_exceeded': 'provider_rate_limited',
  'executor_error': 'runner_crash',
  'diff_review_rejected': 'review_diff_rejected',
  'degenerate_exhausted': 'runner_supervisor_interrupt',
  'time_ceiling': 'guard_time_ceiling',
  'max_turns': 'lifecycle_review_loop_capped',
  'reviewer_separation_unsatisfiable': 'config_main_agent_pricing_unresolvable',
};

export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  retriable: boolean;
}

export function classifyError(
  err: unknown,
  _ctx: { stage?: string; route?: string } = {},
): ClassifiedError {
  const structured = (err as any)?.structuredError;
  const rawCode: string | undefined = structured?.code;
  const mapped = rawCode ? (STRUCTURED_CODE_TO_ERRORCODE[rawCode] ?? rawCode) : undefined;
  const code = (mapped as ErrorCode | undefined) ?? (rawCode as ErrorCode | undefined) ?? 'other';

  const message = (err as any)?.message ?? String(err ?? '');

  return {
    code,
    message,
    retriable:
      code.startsWith('provider_') ||
      code.startsWith('runner_'),
  };
}
