import { spawn } from 'node:child_process';

export interface VerifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export class VerifyStageRunner {
  async run(command: string, cwd: string): Promise<VerifyResult> {
    return new Promise((resolve) => {
      const proc = spawn(command, { shell: true, cwd });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('exit', (code) => {
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          errorCode: code === 0 ? undefined : 'validator_verify_command_failed',
        });
      });
    });
  }
}
