import { runVerifyStage } from '@zhixuan92/multi-model-agent-core/lifecycle/handlers/verify-stage.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CWD = tmpdir();

/**
 * Helper: create a temporary git repo so dirty-tree tests have a real worktree.
 * Returns the path and a cleanup function.
 */
function makeTempGitRepo(): { cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mma-verify-test-'));
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir });
  execSync('git config user.email test@test.test', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  // Create an initial commit so the tree is clean
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add README.md && git commit -m init', { cwd: dir });
  return { cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('runVerifyStage', () => {
  // ---------------------------------------------------------------------------
  // Invariant 2: Exit-code → status mapping
  //   0 → 'passed'; non-zero → 'failed_exit' with errorCode
  //   `validator_verify_command_failed` for non-zero exits.
  // ---------------------------------------------------------------------------
  it('INVARIANT 2: exit 0 → status=passed, no errorCode', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['echo ok'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('passed');
    expect(r.steps[0].status).toBe('passed');
    expect(r.steps[0].exitCode).toBe(0);
    expect(r.steps[0].errorCode).toBeUndefined();
  });

  it('INVARIANT 2: non-zero exit → status=failed_exit with errorCode validator_verify_command_failed', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['exit 3'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('failed');
    expect(r.steps[0].status).toBe('failed_exit');
    expect(r.steps[0].exitCode).toBe(3);
    expect(r.steps[0].errorCode).toBe('validator_verify_command_failed');
  });

  it('INVARIANT 2: multiple commands stop on first failure', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['exit 1', 'echo never'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].status).toBe('failed_exit');
  });

  // ---------------------------------------------------------------------------
  // Invariant 3: errorCode emission — `validator_verify_command_failed`
  //   (post-Phase-2.7 prefix; not the 3.12 `verify_command_failed`).
  // ---------------------------------------------------------------------------
  it('INVARIANT 3: errorCode is validator_verify_command_failed (not verify_command_failed)', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['exit 1'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.steps[0].errorCode).toBe('validator_verify_command_failed');
    // explicit negative check: old prefix must not appear
    expect(r.steps[0].errorCode).not.toBe('verify_command_failed');
  });

  it('INVARIANT 3: passed steps have NO errorCode (contrast with failed)', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['echo hi', 'echo there'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    for (const step of r.steps) {
      expect(step.errorCode).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------------
  // Invariant 1: Timeout enforcement
  //   Verify command killed at timeoutMs; emits appropriate error.
  // ---------------------------------------------------------------------------
  it('INVARIANT 1: per-step timeout kills the command and emits errorCode', async () => {
    // 1ms timeout is too short for `sleep 5`; the step must time out
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['sleep 5'],
      taskTimeoutMs: 100,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('error');
    expect(r.steps[0].status).toBe('timeout');
    expect(r.steps[0].errorCode).toBe('validator_verify_command_failed');
  });

  it('INVARIANT 1: task budget exhausted → timeout step with task_timeout_budget_exhausted errorMessage', async () => {
    // taskStartMs is in the past so the budget is already exhausted
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['echo hi'],
      taskTimeoutMs: 100,
      taskStartMs: Date.now() - 200,
    });
    expect(r.steps[0].status).toBe('timeout');
    expect(r.steps[0].errorMessage).toBe('task_timeout_budget_exhausted');
    expect(r.steps[0].errorCode).toBe('validator_verify_command_failed');
  });

  // ---------------------------------------------------------------------------
  // Invariant 4: captureStdout cap
  //   Stdout truncated at the configured byte cap (TAIL_BYTES = 8 KB);
  //   truncation noted in result via stdoutTail being capped.
  // ---------------------------------------------------------------------------
  it('INVARIANT 4: stdout is capped at 8 KB rolling tail', async () => {
    // Generate ~10KB of output and verify stdoutTail is capped
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['python3 -c "print(\"X\" * 10240)" 2>/dev/null || ruby -e "puts \"X\" * 10240" 2>/dev/null || node -e "process.stdout.write(\"X\".repeat(10240))"'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    const tail = r.steps[0].stdoutTail;
    // Should be capped at most 8KB (8192 bytes)
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    expect(tailBytes).toBeLessThanOrEqual(8192 + 64); // allow small slop for newlines/encoding
    // With 10KB input, a proper cap means it won't contain all 10,240 X's
    expect(tail.length).toBeLessThan(10240);
  });

  // ---------------------------------------------------------------------------
  // Invariant 5: Env-var allowlist
  //   Only allowlisted env vars passed to the child process; secrets excluded.
  // ---------------------------------------------------------------------------
  it('INVARIANT 5: with permittedEnv, only allowlisted vars are forwarded to child', async () => {
    // Set a secret var that must NOT be visible to the child
    process.env.MMA_TEST_SECRET = 'should-not-leak';
    process.env.MMA_TEST_ALLOWED = 'visible-value';
    try {
      // Use `env` to list all visible env vars — no shell variable expansion needed.
      // Use /tmp as CWD because bash -lc + detached + restricted env can hang
      // on macOS tmpdir paths under /var/folders.
      const r = await runVerifyStage({
        cwd: '/tmp',
        verifyCommand: ['env | grep MMA_TEST || true'],
        taskTimeoutMs: 60000,
        taskStartMs: Date.now(),
        permittedEnv: ['MMA_TEST_ALLOWED'],
      });
      const out = r.steps[0].stdoutTail;
      expect(out).toContain('MMA_TEST_ALLOWED=visible-value');
      // The secret must NOT appear in the child's env
      expect(out).not.toContain('MMA_TEST_SECRET');
      expect(out).not.toContain('should-not-leak');
    } finally {
      delete process.env.MMA_TEST_SECRET;
      delete process.env.MMA_TEST_ALLOWED;
    }
  });

  it('INVARIANT 5: without permittedEnv, full parent env is inherited (default behavior)', async () => {
    process.env.MMA_TEST_VAR = 'value-from-parent';
    try {
      const r = await runVerifyStage({
        cwd: CWD,
        verifyCommand: ['echo MMA_TEST_VAR=$MMA_TEST_VAR'],
        taskTimeoutMs: 60000,
        taskStartMs: Date.now(),
      });
      expect(r.steps[0].stdoutTail).toContain('MMA_TEST_VAR=value-from-parent');
    } finally {
      delete process.env.MMA_TEST_VAR;
    }
  });

  // ---------------------------------------------------------------------------
  // Invariant 6: Dirty-tree-after-verify behavior
  //   If the verify command modifies the worktree, report dirtyFiles;
  //   do NOT auto-commit those changes.
  // ---------------------------------------------------------------------------
  it('INVARIANT 6: checkDirtyTree detects files modified by verify command', async () => {
    const { cwd, cleanup } = makeTempGitRepo();
    try {
      // Verify command that creates a new file (dirties the worktree)
      const r = await runVerifyStage({
        cwd,
        verifyCommand: ['echo new-content > dirty-file.txt'],
        taskTimeoutMs: 60000,
        taskStartMs: Date.now(),
        checkDirtyTree: true,
      });
      expect(r.status).toBe('passed');
      expect(r.dirtyFiles).toBeDefined();
      expect(r.dirtyFiles!.length).toBeGreaterThan(0);
      expect(r.dirtyFiles!.some((f) => f.includes('dirty-file.txt'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('INVARIANT 6: clean worktree after verify → no dirtyFiles', async () => {
    const { cwd, cleanup } = makeTempGitRepo();
    try {
      // Verify command that does NOT modify the worktree
      const r = await runVerifyStage({
        cwd,
        verifyCommand: ['echo hello'],
        taskTimeoutMs: 60000,
        taskStartMs: Date.now(),
        checkDirtyTree: true,
      });
      expect(r.status).toBe('passed');
      expect(r.dirtyFiles).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('INVARIANT 6: checkDirtyTree=false → no dirtyFiles even when worktree is dirty', async () => {
    const { cwd, cleanup } = makeTempGitRepo();
    try {
      // Verify command dirties tree, but checkDirtyTree is not set
      const r = await runVerifyStage({
        cwd,
        verifyCommand: ['echo messy > dirty-output.txt'],
        taskTimeoutMs: 60000,
        taskStartMs: Date.now(),
      });
      expect(r.dirtyFiles).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // General behavior tests (not invariants, but ensure robustness)
  // ---------------------------------------------------------------------------
  it('returns status=skipped with skipReason=no_command when verifyCommand is undefined', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: undefined,
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('skipped');
    expect(r.skipReason).toBe('no_command');
    expect(r.steps).toEqual([]);
  });

  it('returns status=skipped when verifyCommand is empty array', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: [],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('skipped');
    expect(r.skipReason).toBe('no_command');
  });

  it('runs commands sequentially, all pass → status=passed', async () => {
    const r = await runVerifyStage({
      cwd: CWD,
      verifyCommand: ['echo a', 'echo b'],
      taskTimeoutMs: 60000,
      taskStartMs: Date.now(),
    });
    expect(r.status).toBe('passed');
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].status).toBe('passed');
    expect(r.steps[1].status).toBe('passed');
  });
});
