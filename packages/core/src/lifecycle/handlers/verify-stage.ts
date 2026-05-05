import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

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
  errorCode?: string;
}

export interface VerifyStageInput {
  cwd: string;
  verifyCommand: string[] | undefined;
  taskTimeoutMs: number;
  taskStartMs: number;
  /** Env-var names to forward to the child process. When undefined, the child
   *  inherits the full parent environment. When provided, only those named vars
   *  (plus a few essential implicit ones: PATH, HOME, SHELL, TMPDIR, LANG) are
   *  forwarded — secrets and unknown vars are excluded. */
  permittedEnv?: string[];
  /** When true, runs `git status --porcelain` in cwd after verification and
   *  populates `dirtyFiles` with any modified/new paths. */
  checkDirtyTree?: boolean;
}

export interface VerifyStageResult {
  status: 'passed' | 'failed' | 'skipped' | 'error';
  steps: VerifyStepResult[];
  totalDurationMs: number;
  skipReason?: 'no_command';
  /** File paths that were modified by the verify command (only populated when
   *  `checkDirtyTree: true` was set and git reported changes). */
  dirtyFiles?: string[];
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

const IMPLICIT_ENV = ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'PWD', 'USER', 'LOGNAME', 'TERM'];

function buildEnv(permittedEnv: string[] | undefined): typeof process.env | undefined {
  if (permittedEnv === undefined) return undefined; // inherit full parent env
  const filtered: Record<string, string | undefined> = {};
  for (const name of [...IMPLICIT_ENV, ...permittedEnv]) {
    if (process.env[name] !== undefined) filtered[name] = process.env[name];
  }
  return filtered as typeof process.env;
}

async function runStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  errorMessageHint: string | null,
  permittedEnv?: string[],
): Promise<VerifyStepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const stdout = new RollingTail();
    const stderr = new RollingTail();
    let resolved = false;

    // Use explicit `bash -lc <cmd>` on POSIX for deterministic behavior; `shell: true` on Windows.
    // detached=true on POSIX so we can kill the process group (catches grandchildren).
    // (Audit-r2 plan finding 7.)
    const spawnOpts: any = { cwd, env: buildEnv(permittedEnv) };
    if (process.platform !== 'win32') spawnOpts.detached = true;
    const child = process.platform === 'win32'
      ? spawn(cmd, { shell: true, ...spawnOpts })
      : spawn('/bin/bash', ['-lc', cmd], spawnOpts);

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
      errorCode: 'validator_verify_command_failed',
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
        errorCode: 'validator_verify_command_failed',
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
          errorCode: 'validator_verify_command_failed',
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
          errorCode: 'validator_verify_command_failed',
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
  if (!input.verifyCommand || input.verifyCommand.length === 0) {
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
        errorCode: 'validator_verify_command_failed',
      });
      break;
    }

    const step = await runStep(cmd, input.cwd, stepTimeout, null, input.permittedEnv);
    steps.push(step);
    if (step.status !== 'passed') break;
  }

  const result: VerifyStageResult = {
    status: aggregateStatus(steps),
    steps,
    totalDurationMs: Date.now() - overallStart,
  };

  // Dirty-tree check: run `git status --porcelain` after verification to detect
  // if the verify command modified the worktree. Do NOT auto-commit these changes.
  if (input.checkDirtyTree) {
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: input.cwd, timeout: 10000 });
      const dirtyFiles = stdout.trim().split('\n').filter(Boolean);
      if (dirtyFiles.length > 0) {
        result.dirtyFiles = dirtyFiles;
      }
    } catch {
      // If git status fails (e.g., not a git repo), leave dirtyFiles undefined.
    }
  }

  return result;
}
