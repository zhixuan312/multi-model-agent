import { describe, it, expect } from 'bun:test';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';

const base = {
  shutdownInProgress: false,
  workerStatus: 'done' as const,
  overallReviewVerdict: 'approved' as const,
  artifactsCheck: 'pass' as const,
  guardFires: [] as string[],
  errorCode: null as string | null,
};

describe('TerminalStatusDeriver truth table', () => {
  const d = new TerminalStatusDeriver();

  it('row 1: shutdownInProgress -> unavailable', () => {
    expect(d.derive({ ...base, shutdownInProgress: true }).terminalStatus).toBe('unavailable');
  });

  it('row 2a: guard_time_ceiling -> timeout', () => {
    expect(d.derive({ ...base, guardFires: ['guard_time_ceiling'] }).terminalStatus).toBe('timeout');
  });

  it('row 3b: guard_idle_timeout -> timeout', () => {
    expect(d.derive({ ...base, guardFires: ['guard_idle_timeout'] }).terminalStatus).toBe('timeout');
  });

  it('row 4: provider_* -> error', () => {
    expect(d.derive({ ...base, errorCode: 'provider_rate_limited' }).terminalStatus).toBe('error');
  });

  it('row 4: runner_* -> error', () => {
    expect(d.derive({ ...base, errorCode: 'runner_transport_failed' }).terminalStatus).toBe('error');
  });

  it('row 5: lifecycle_review_loop_capped -> incomplete', () => {
    expect(d.derive({ ...base, errorCode: 'lifecycle_review_loop_capped' }).terminalStatus).toBe('incomplete');
  });

  it('row 6: intake_brief_invalid -> brief_too_vague', () => {
    expect(d.derive({ ...base, errorCode: 'intake_brief_invalid' }).terminalStatus).toBe('brief_too_vague');
  });

  it('row 7: artifactsCheck=fail -> incomplete + validator_no_artifacts', () => {
    const r = d.derive({ ...base, artifactsCheck: 'fail' });
    expect(r.terminalStatus).toBe('incomplete');
    expect(r.errorCode).toBe('validator_no_artifacts');
  });

  it('row 8: happy path with review approved -> ok', () => {
    expect(d.derive({ ...base }).terminalStatus).toBe('ok');
  });

  it('row 9: happy path with concerns -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'concerns' }).terminalStatus).toBe('ok');
  });

  it('row 9: happy path with annotated -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'annotated' }).terminalStatus).toBe('ok');
  });

  it('row 9: happy path with not_applicable -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'not_applicable' }).terminalStatus).toBe('ok');
  });

  it('row 9: done_with_concerns counts as workerOk', () => {
    expect(d.derive({ ...base, workerStatus: 'done_with_concerns' }).terminalStatus).toBe('ok');
  });

  it('row 10 fallback: workerStatus=blocked -> incomplete + silent_incomplete', () => {
    const r = d.derive({ ...base, workerStatus: 'blocked' });
    expect(r.terminalStatus).toBe('incomplete');
    expect(r.errorCode).toBe('validator_silent_incomplete');
  });

  it('row 10 fallback: workerStatus=failed -> incomplete', () => {
    expect(d.derive({ ...base, workerStatus: 'failed' }).terminalStatus).toBe('incomplete');
  });
});
