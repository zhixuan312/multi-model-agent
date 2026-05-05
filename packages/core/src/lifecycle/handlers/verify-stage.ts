import { spawn } from 'node:child_process';

export type VerifyStepStatus = 'passed' | 'failed_exit' | 'spawn_error' | 'timeout' | 'signal' | 'system_error';

export interface VerifyStepResult {
  command: string;
  status: VerifyStepStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  errorMessage: string | null;
}

export interface VerifyStageInput {
  cwd: string;
  verifyCommand: string[] | undefined;
  taskTimeoutMs: number;
  taskStartMs: number;
}

export interface VerifyStageResult {
  status: 'passed' | 'failed' | 'skipped' | 'error';
  steps: VerifyStepResult[];
  totalDurationMs: number;
  skipReason?: 'no_command';
}

const TAIL_BYTES = 8 * 1024;

// Rolling tail buffer that retains only the last TAIL_BYTES bytes of UTF-8 input.
// This avoids unbounded memory growth on noisy verification commands (Audit-r2 plan finding 8).
class RollingTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(s: string): void {
    const buf = Buffer.from(s, 'utf8');
    this.chunks.push(buf);
    this.bytes += buf.length;
    while (this.chunks.length > 0 && this.bytes - this.chunks[0].length >= TAIL_BYTES) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  toString(): string {
    if (this.bytes === 0) return '';
    const concat = Buffer.concat(this.chunks);
    if (concat.length <= TAIL_BYTES) return concat.toString('utf8');
    // Truncate at TAIL_BYTES from the end. This may cut a UTF-8 boundary;
    // toString('utf8') replaces invalid leading bytes with the replacement char.
    // For 3.3.0 we accept this; reviewer prompts already say tails are best-effort. (Audit-r2 plan #9)
    return concat.subarray(concat.length - TAIL_BYTES).toString('utf8');
  }
}

async function runStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  errorMessageHint: string | null,
): Promise<VerifyStepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const stdout = new RollingTail();
    const stderr = new RollingTail();
    let resolved = false;

    // Use explicit `bash -lc <cmd>` on POSIX for deterministic behavior; `shell: true` on Windows.
    // detached=true on POSIX so we can kill the process group (catches grandchildren).
    // (Audit-r2 plan finding 7.)
    const child = process.platform === 'win32'
      ? spawn(cmd, { shell: true, cwd })
      : spawn('/bin/bash', ['-lc', cmd], { cwd, detached: true });

    const finish = (r: VerifyStepResult): void => {
      if (!resolved) {
        resolved = true;
        resolve(r);
      }
    };

    const makeTimeoutResult = (): VerifyStepResult => ({
      command: cmd,
      status: 'timeout',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - start,
      stdoutTail: stdout.toString(),
      stderrTail: stderr.toString(),
      errorMessage: errorMessageHint ?? 'per_step_timeout',
    });

    const to = setTimeout(() => {
      if (resolved) return;
      finish(makeTimeoutResult());
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Best-effort kill; the timeout result has already been recorded.
      }
    }, Math.max(1, timeoutMs));

    child.stdout?.on('data', (d: Buffer | string) => stdout.push(d.toString()));
    child.stderr?.on('data', (d: Buffer | string) => stderr.push(d.toString()));

    child.on('error', (err) => {
      clearTimeout(to);
      finish({
        command: cmd,
        status: 'spawn_error',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - start,
        stdoutTail: stdout.toString(),
        stderrTail: stderr.toString(),
        errorMessage: err.message,
      });
    });

    child.on('close', (code, sig) => {
      clearTimeout(to);
      if (resolved) return;
      if (sig) {
        finish({
          command: cmd,
          status: 'signal',
          exitCode: null,
          signal: sig,
          durationMs: Date.now() - start,
          stdoutTail: stdout.toString(),
          stderrTail: stderr.toString(),
          errorMessage: `terminated by ${sig}`,
        });
      } else if (code === 0) {
        finish({
          command: cmd,
          status: 'passed',
          exitCode: 0,
          signal: null,
          durationMs: Date.now() - start,
          stdoutTail: stdout.toString(),
          stderrTail: stderr.toString(),
          errorMessage: null,
        });
      } else {
        finish({
          command: cmd,
          status: 'failed_exit',
          exitCode: code ?? null,
          signal: null,
          durationMs: Date.now() - start,
          stdoutTail: stdout.toString(),
          stderrTail: stderr.toString(),
          errorMessage: null,
        });
      }
    });
  });
}

function aggregateStatus(steps: VerifyStepResult[]): VerifyStageResult['status'] {
  if (steps.length === 0) return 'skipped';
  const last = steps[steps.length - 1];
  if (last.status === 'passed') return 'passed';
  if (last.status === 'failed_exit') return 'failed';
  return 'error';
}

export async function runVerifyStage(input: VerifyStageInput): Promise<VerifyStageResult> {
  if (!input.verifyCommand) {
    return { status: 'skipped', steps: [], totalDurationMs: 0, skipReason: 'no_command' };
  }

  const overallStart = Date.now();
  const steps: VerifyStepResult[] = [];

  for (const cmd of input.verifyCommand) {
    const elapsed = Date.now() - input.taskStartMs;
    const remaining = Math.max(0, input.taskTimeoutMs - elapsed);
    const stepTimeout = Math.min(input.taskTimeoutMs / 4, 600_000, remaining);

    if (stepTimeout <= 0) {
      steps.push({
        command: cmd,
        status: 'timeout',
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
        errorMessage: 'task_timeout_budget_exhausted',
      });
      break;
    }

    const step = await runStep(cmd, input.cwd, stepTimeout, null);
    steps.push(step);
    if (step.status !== 'passed') break;
  }

  return { status: aggregateStatus(steps), steps, totalDurationMs: Date.now() - overallStart };
}
