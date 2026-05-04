import { describe, it, expect } from 'vitest';
import { VerifyStageRunner } from '../../packages/core/src/reporting/verify-stage-runner.js';

describe('VerifyStageRunner', () => {
  it('returns exitCode 0 on success with no errorCode', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('echo hi', '/tmp');
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.errorCode).toBeUndefined();
    expect(res.stdout).toContain('hi');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits validator_verify_command_failed on non-zero exit', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('exit 1', '/tmp');
    expect(res.exitCode).toBe(1);
    expect(res.signal).toBeNull();
    expect(res.errorCode).toBe('validator_verify_command_failed');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stdout and stderr content', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('echo stdout; echo stderr >&2', '/tmp');
    expect(res.stdout).toContain('stdout');
    expect(res.stderr).toContain('stderr');
  });

  it('resolves with exitCode 127 and errorCode on command not found (shell catches it)', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('nonexistent_command_xyz_123', '/tmp');
    expect(res.exitCode).toBe(127);
    expect(res.errorCode).toBe('validator_verify_command_failed');
    expect(res.stderr).toContain('command not found');
  });

  it('detects signal termination', async () => {
    const r = new VerifyStageRunner();
    // `kill $$` sends SIGTERM to the shell process
    const res = await r.run('kill $$', '/tmp');
    expect(res.signal).not.toBeNull();
    expect(res.errorCode).toBe('validator_verify_command_failed');
  });

  it('resolves with errorCode on timeout', async () => {
    const r = new VerifyStageRunner();
    const res = await r.run('sleep 10', '/tmp', { timeoutMs: 100 });
    expect(res.errorCode).toBe('validator_verify_command_failed');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    // exitCode should be -1 (timeout, never exited normally)
  });

  it('rejects when spawn errors (ENOENT) with cwd that does not exist', async () => {
    const r = new VerifyStageRunner();
    await expect(
      r.run('echo hi', '/nonexistent/path/that/should/not/exist'),
    ).rejects.toThrow();
  });
});
