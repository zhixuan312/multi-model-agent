import { describe, it, expect } from 'vitest';
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

  it('shutdownInProgress -> unavailable', () => {
    expect(d.derive({ ...base, shutdownInProgress: true }).terminalStatus).toBe('unavailable');
  });

  it('guard_time_ceiling fire -> timeout', () => {
    expect(d.derive({ ...base, guardFires: ['guard_time_ceiling'] }).terminalStatus).toBe('timeout');
  });

  it('guard_idle_timeout fire -> timeout', () => {
    expect(d.derive({ ...base, guardFires: ['guard_idle_timeout'] }).terminalStatus).toBe('timeout');
  });

  it('wall_clock_exceeded errorCode -> timeout', () => {
    expect(d.derive({ ...base, errorCode: 'wall_clock_exceeded' }).terminalStatus).toBe('timeout');
  });

  it('aborted errorCode -> timeout', () => {
    expect(d.derive({ ...base, errorCode: 'aborted' }).terminalStatus).toBe('timeout');
  });

  it('sdk_max_turns -> error', () => {
    expect(d.derive({ ...base, errorCode: 'sdk_max_turns' }).terminalStatus).toBe('error');
  });

  it('sdk_max_budget -> error', () => {
    expect(d.derive({ ...base, errorCode: 'sdk_max_budget' }).terminalStatus).toBe('error');
  });

  it('codex_error -> error', () => {
    expect(d.derive({ ...base, errorCode: 'codex_error' }).terminalStatus).toBe('error');
  });

  it('spawn_failed -> error', () => {
    expect(d.derive({ ...base, errorCode: 'spawn_failed' }).terminalStatus).toBe('error');
  });

  it('exit_1 (dynamic codex exit code) -> error', () => {
    expect(d.derive({ ...base, errorCode: 'exit_1' }).terminalStatus).toBe('error');
  });

  it('artifactsCheck=fail -> incomplete + validator_no_artifacts', () => {
    const r = d.derive({ ...base, artifactsCheck: 'fail' });
    expect(r.terminalStatus).toBe('incomplete');
    expect(r.errorCode).toBe('validator_no_artifacts');
  });

  it('happy path with review approved -> ok', () => {
    expect(d.derive({ ...base }).terminalStatus).toBe('ok');
  });

  it('happy path with concerns -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'concerns' }).terminalStatus).toBe('ok');
  });

  it('happy path with annotated -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'annotated' }).terminalStatus).toBe('ok');
  });

  it('happy path with not_applicable -> ok', () => {
    expect(d.derive({ ...base, overallReviewVerdict: 'not_applicable' }).terminalStatus).toBe('ok');
  });

  it('done_with_concerns counts as workerOk', () => {
    expect(d.derive({ ...base, workerStatus: 'done_with_concerns' }).terminalStatus).toBe('ok');
  });

  it('fallback: workerStatus=blocked -> incomplete + silent_incomplete', () => {
    const r = d.derive({ ...base, workerStatus: 'blocked' });
    expect(r.terminalStatus).toBe('incomplete');
    expect(r.errorCode).toBe('validator_silent_incomplete');
  });

  it('fallback: workerStatus=failed -> incomplete', () => {
    expect(d.derive({ ...base, workerStatus: 'failed' }).terminalStatus).toBe('incomplete');
  });
});
