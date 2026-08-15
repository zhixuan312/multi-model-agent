import { describe, it, expect } from 'vitest';
import { mapStatusToWire } from '../../packages/core/src/events/to-wire-record.js';

/**
 * This file used to be titled "exhaustive" and covered ten branches, seven of which mapped codes
 * nothing in the engine produces — the retired lifecycle vocabulary (`incomplete`,
 * `brief_too_vague`, `needs_context`, `blocked`, `review_loop_capped`), the same values that lived
 * in the deleted `runner-types.ts`. Covering them is exactly why they looked alive: a test proving
 * the function maps X to Y says nothing about whether anything produces X.
 *
 * Every code below is one the engine can ACTUALLY set. v7 stopped reporting all of them as a flat
 * `error` and split out the three that a reader would act on differently — see the groups.
 */

/** Genuine failures: the work ran and went wrong. */
const ERROR_CODES = [
  'sdk_max_turns', 'sdk_max_budget', 'sdk_execution_error',
  'sdk_max_structured_output_retries', 'turn_failed', 'codex_error',
  // pipeline codes (two-phase-pipeline.ts)
  'implementer_no_output', 'implementer_request_rejected', 'materialization_failed',
  'rematerialization_failed', 'pipeline_failed',
  // ContractPlanError codes
  'unsupported-legacy-plan', 'malformed-plan', 'unsafe-test-path', 'test-path-collision',
];

/** The provider could not be reached or authenticated — a fact about the operator's
 *  environment, not about the task. Filing these as `error` inflated the engine's own
 *  failure rate with other people's missing API keys. */
const UNAVAILABLE_CODES = [
  'sdk_no_result', 'codex_not_installed', 'spawn_failed',
  'missing_credentials', 'invalid_api_key',
];

describe('mapStatusToWire', () => {
  it('maps a successful run to ok, keeping the concerns distinction', () => {
    expect(mapStatusToWire('done', null)).toEqual({ terminalStatus: 'ok', workerStatus: 'done' });
    expect(mapStatusToWire('done_with_concerns', null))
      .toEqual({ terminalStatus: 'ok', workerStatus: 'done_with_concerns' });
  });

  it.each(ERROR_CODES)('reports %s as terminalStatus=error', (code) => {
    expect(mapStatusToWire('failed', code)).toEqual({ terminalStatus: 'error', workerStatus: 'failed' });
  });

  it.each(UNAVAILABLE_CODES)('reports %s as terminalStatus=unavailable', (code) => {
    expect(mapStatusToWire('failed', code)).toEqual({ terminalStatus: 'unavailable', workerStatus: 'failed' });
  });

  it('reports a wall-clock overrun as timeout, not error', () => {
    // A budget question, not a defect. Collapsed into `error`, a fleet whose
    // timeouts were climbing looked identical to one that was crashing.
    expect(mapStatusToWire('failed', 'wall_clock_exceeded'))
      .toEqual({ terminalStatus: 'timeout', workerStatus: 'failed' });
  });

  it('reports a caller-initiated cancel as cancelled, not a failure', () => {
    // Both routes to the same conclusion: the explicit flag the runtime sets
    // when DELETE /task/:id wins the race, and the `aborted` turn code that
    // tearing the worker down produces.
    expect(mapStatusToWire('failed', 'aborted'))
      .toEqual({ terminalStatus: 'cancelled', workerStatus: 'cancelled' });
    expect(mapStatusToWire('failed', 'pipeline_failed', true))
      .toEqual({ terminalStatus: 'cancelled', workerStatus: 'cancelled' });
  });

  it('lets the cancel flag win over an otherwise-successful pipeline', () => {
    // A cancel that lands after the implementer finished still ends as a cancel;
    // reporting `ok` would credit the engine with work the caller stopped.
    expect(mapStatusToWire('done', null, true))
      .toEqual({ terminalStatus: 'cancelled', workerStatus: 'cancelled' });
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
      for (const code of [null, ...ERROR_CODES, ...UNAVAILABLE_CODES, 'wall_clock_exceeded', 'aborted']) {
        const wire = mapStatusToWire(status, code);
        if (wire.terminalStatus === 'ok') {
          expect(['done', 'done_with_concerns']).toContain(wire.workerStatus);
        }
      }
    }
  });
});
