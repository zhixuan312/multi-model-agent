import { z } from 'zod';

// Canonical errorCode vocabulary — single source of truth for both runtime
// emission and telemetry validation. Codes listed here are actually emitted
// by providers and the terminal-status deriver; the schema rejects unknown
// codes so they must be kept in sync with the emitters.
export const ErrorCodeSchema = z.enum([
  // Claude SDK termination codes (normalize-claude.ts)
  'sdk_max_turns',
  'sdk_max_budget',
  'sdk_execution_error',
  'sdk_max_structured_output_retries',
  // Codex CLI termination codes (codex-cli-session.ts)
  'aborted',
  'wall_clock_exceeded',
  'turn_failed',
  'codex_error',
  'codex_not_installed',
  'spawn_failed',
  // Terminal-status deriver (terminal-status-deriver.ts)
  'validator_no_artifacts',
  'validator_silent_incomplete',
  // sentinel for unrecognized or dynamic codes (e.g. exit_${N})
  'other',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

