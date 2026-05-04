import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

export interface VerifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: string | null;
  durationMs: number;
  errorCode?: string;
}

export interface VerifyStageRunnerOptions {
  timeoutMs?: number;
}

class RollingTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(s: string): void {
    const buf = Buffer.from(s, 'utf8');
    this.chunks.push(buf);
    this.bytes += buf.length;
    while (this.chunks.length > 0 && this.bytes - this.chunks[0].length >= MAX_OUTPUT_BYTES) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  toString(): string {
    if (this.bytes === 0) return '';
    const concat = Buffer.concat(this.chunks);
    if (concat.length <= MAX_OUTPUT_BYTES) return concat.toString('utf8');
    return concat.subarray(concat.length - MAX_OUTPUT_BYTES).toString('utf8');
  }
}

export class VerifyStageRunner {
  /**
   * Run a post-implementation verify command (e.g. `npm test`).
   *
   * IMPORTANT: `command` is executed via `shell: true` and MUST be trusted input
   * (config-supplied, not user-supplied). Do not pass unsanitized user input here.
   */
  async run(command: string, cwd: string, options: VerifyStageRunnerOptions = {}): Promise<VerifyResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const proc = spawn(command, { shell: true, cwd });
      const stdout = new RollingTail();
      const stderr = new RollingTail();
      let resolved = false;

      const finish = (result: VerifyResult): void => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        finish({
          exitCode: -1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          signal: null,
          durationMs: Date.now() - start,
          errorCode: 'validator_verify_command_failed',
        });
        try {
          proc.kill('SIGKILL');
        } catch {
          // best-effort kill
        }
      }, Math.max(1, timeoutMs));

      proc.stdout?.on('data', (d: Buffer | string) => stdout.push(d.toString()));
      proc.stderr?.on('data', (d: Buffer | string) => stderr.push(d.toString()));

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('exit', (code, sig) => {
        clearTimeout(timer);
        if (sig) {
          finish({
            exitCode: code ?? -1,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            signal: sig,
            durationMs: Date.now() - start,
            errorCode: 'validator_verify_command_failed',
          });
        } else if (code === 0) {
          finish({
            exitCode: 0,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            signal: null,
            durationMs: Date.now() - start,
          });
        } else {
          finish({
            exitCode: code ?? -1,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            signal: null,
            durationMs: Date.now() - start,
            errorCode: 'validator_verify_command_failed',
          });
        }
      });
    });
  }
}
