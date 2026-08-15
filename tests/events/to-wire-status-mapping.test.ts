import { describe, it, expect } from 'vitest';
import { mapStatusToWire } from '../../packages/core/src/events/to-wire-record.js';

/**
 * This file used to be titled "exhaustive" and covered ten branches, seven of which mapped codes
 * nothing in the engine produces — the retired lifecycle vocabulary (`incomplete`, `timeout`,
 * `brief_too_vague`, `unavailable`, `needs_context`, `blocked`, `review_loop_capped`), the same
 * values that lived in the deleted `runner-types.ts`. Covering them is exactly why they looked
 * alive: a test proving the function maps X to Y says nothing about whether anything produces X.
 *
 * What is asserted now is the mapping over codes the engine can ACTUALLY set — every provider
 * turn code, every pipeline code, every ContractPlanError code — all of which report `error`.
 * That is the real, and deliberately flat, behaviour; `errorCode` on the same wire record is
 * what preserves which failure it was.
 */
const REACHABLE_FAILURE_CODES = [
  // provider turn codes (normalize-claude.ts, codex-cli-session.ts)
  'wall_clock_exceeded', 'aborted', 'sdk_no_result', 'sdk_max_turns', 'sdk_max_budget',
  'sdk_execution_error', 'sdk_max_structured_output_retries', 'turn_failed', 'codex_error',
  'codex_not_installed', 'spawn_failed', 'missing_credentials', 'invalid_api_key',
  // pipeline codes (two-phase-pipeline.ts)
  'implementer_no_output', 'implementer_request_rejected', 'materialization_failed',
  'rematerialization_failed', 'pipeline_failed',
  // ContractPlanError codes
  'unsupported-legacy-plan', 'malformed-plan', 'unsafe-test-path', 'test-path-collision',
];

describe('mapStatusToWire', () => {
  it('maps a successful run to ok, keeping the concerns distinction', () => {
    expect(mapStatusToWire('done', null)).toEqual({ terminalStatus: 'ok', workerStatus: 'done' });
    expect(mapStatusToWire('done_with_concerns', null))
      .toEqual({ terminalStatus: 'ok', workerStatus: 'done_with_concerns' });
  });

  it.each(REACHABLE_FAILURE_CODES)('reports %s as terminalStatus=error', (code) => {
    expect(mapStatusToWire('failed', code)).toEqual({ terminalStatus: 'error', workerStatus: 'failed' });
  });

  it('reports a failure with no code, and an unrecognised one, the same way', () => {
    expect(mapStatusToWire('failed', null)).toEqual({ terminalStatus: 'error', workerStatus: 'failed' });
    expect(mapStatusToWire('failed', 'something_new')).toEqual({ terminalStatus: 'error', workerStatus: 'failed' });
  });

  /**
   * The R1 invariant in `wire-schema.ts` (`terminalStatus=ok` requires a non-failed
   * workerStatus) holds for everything this function can return — asserted here rather than
   * left to a schema parse somewhere downstream.
   */
  it('never pairs ok with a failed worker outcome', () => {
    for (const status of ['done', 'done_with_concerns', 'failed'] as const) {
      const wire = mapStatusToWire(status, 'pipeline_failed');
      if (wire.terminalStatus === 'ok') {
        expect(['done', 'done_with_concerns']).toContain(wire.workerStatus);
      }
    }
  });
});
