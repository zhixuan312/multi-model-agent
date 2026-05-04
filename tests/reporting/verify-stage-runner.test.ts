import { describe, it, expect } from 'vitest';
import { VerifyStageRunner } from '../../packages/core/src/reporting/verify-stage-runner.js';

describe('VerifyStageRunner', () => {
  it('returns 0 on success', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('echo hi', '/tmp');
    expect(res.exitCode).toBe(0);
    expect(res.errorCode).toBeUndefined();
  });

  it('emits validator_verify_command_failed on non-zero', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('exit 1', '/tmp');
    expect(res.exitCode).not.toBe(0);
    expect(res.errorCode).toBe('validator_verify_command_failed');
  });
});
