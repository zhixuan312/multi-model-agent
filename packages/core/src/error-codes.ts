// Canonical errorCode vocabulary per C6 spec. Every code starts with one of
// 9 closed prefixes: provider_, runner_, tool_, guard_, review_, validator_,
// config_, intake_, lifecycle_. The `other` sentinel is for unexpected errors
// not yet categorized.
export type ErrorCode =
  // provider_* — provider HTTP/SDK errors
  | 'provider_rate_limited'
  | 'provider_auth_failed'
  | 'provider_transport_failure'
  | 'provider_api_error'
  | 'provider_api_aborted'
  | 'provider_timeout'
  // runner_* — runner internals
  | 'runner_crash'
  | 'runner_invalid_response'
  | 'runner_supervisor_interrupt'
  // tool_* — tool execution
  | 'tool_sandbox_cwd_violation'
  | 'tool_egress_blocked'
  | 'tool_path_invalid'
  | 'tool_handler_exception'
  // guard_* — bounded-execution guards
  | 'guard_cost_ceiling'
  | 'guard_time_ceiling'
  | 'guard_wall_clock'
  | 'guard_idle_timeout'
  // review_* — review-path terminal outcomes
  | 'review_diff_rejected'
  | 'review_spec_rejected_terminal'
  | 'review_quality_findings_unresolved'
  // validator_* — post-execution validators
  | 'validator_no_artifacts'
  | 'validator_silent_incomplete'
  | 'validator_dirty_worktree'
  | 'validator_verify_command_failed'
  // config_* — boot-time config errors
  | 'config_invalid_profile'
  | 'config_main_agent_pricing_unresolvable'
  // intake_* — intake stage errors
  | 'intake_brief_invalid'
  // lifecycle_* — lifecycle orchestration
  | 'lifecycle_review_loop_capped'
  | 'lifecycle_idle_exceeded'
  // sentinel
  | 'other';

export function retryableFor(status: string): boolean {
  return ['timeout', 'provider_transport_failure', 'api_error'].includes(status);
}

export function classifyContextBlockError(err: Error): 'context_block_not_found' | 'retryable' | 'non_retryable' {
  const msg = err.message.toLowerCase();
  if (msg.includes('context block') || (msg.includes('id') && msg.includes('undefined'))) {
    if (msg.includes('not found') || msg.includes('undefined') || msg.includes('missing')) {
      return 'context_block_not_found';
    }
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503') || msg.includes('502')) {
    return 'retryable';
  }
  return 'non_retryable';
}
