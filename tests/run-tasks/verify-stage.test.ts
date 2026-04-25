import { runVerifyStage } from '@zhixuan92/multi-model-agent-core/run-tasks/verify-stage.js';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const CWD = tmpdir();

describe('runVerifyStage', () => {
  it('returns status=skipped with skipReason=no_command when verifyCommand is undefined', async () => {
    const r = await runVerifyStage({ cwd: CWD, verifyCommand: undefined, taskTimeoutMs: 60000, taskStartMs: Date.now() });
    expect(r.status).toBe('skipped');
    expect(r.skipReason).toBe('no_command');
    expect(r.steps).toEqual([]);
  });

  it('runs commands sequentially, all pass → status=passed', async () => {
    const r = await runVerifyStage({ cwd: CWD, verifyCommand: ['echo a', 'echo b'], taskTimeoutMs: 60000, taskStartMs: Date.now() });
    expect(r.status).toBe('passed');
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].status).toBe('passed');
    expect(r.steps[1].status).toBe('passed');
  });

  it('stops on first non-passed; later steps not run', async () => {
    const r = await runVerifyStage({ cwd: CWD, verifyCommand: ['false', 'echo never'], taskTimeoutMs: 60000, taskStartMs: Date.now() });
    expect(r.status).toBe('failed');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].status).toBe('failed_exit');
    expect(r.steps[0].exitCode).toBe(1);
  });

  it('exit 127 (command not found inside shell) is failed_exit, not spawn_error', async () => {
    const r = await runVerifyStage({ cwd: CWD, verifyCommand: ['nonexistentcmd_xyz'], taskTimeoutMs: 60000, taskStartMs: Date.now() });
    expect(r.steps[0].status).toBe('failed_exit');
    expect(r.steps[0].exitCode).toBe(127);
  });

  it('per-step timeout uses min(task/4, 600000, remaining)', async () => {
    const r = await runVerifyStage({ cwd: CWD, verifyCommand: ['sleep 5'], taskTimeoutMs: 1000, taskStartMs: Date.now() - 800 });
    expect(r.status).toBe('error');
    expect(r.steps[0].status).toBe('timeout');
  });
});
