import fs from 'fs/promises';
import { glob as fsGlob } from 'node:fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { FileTracker } from './tracker.js';
import type { SandboxPolicy } from '../../types.js';

const execAsync = promisify(exec);

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

async function resolveReal(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    // File doesn't exist — resolve the nearest existing ancestor and
    // append the remaining path components so symlinks in ancestors
    // are still caught.
    const parent = path.dirname(target);
    if (parent === target) return target; // filesystem root
    const realParent = await resolveReal(parent);
    return path.join(realParent, path.basename(target));
  }
}

async function assertWithinCwd(cwd: string, resolved: string): Promise<void> {
  const realCwd = await fs.realpath(cwd);
  const realResolved = await resolveReal(resolved);

  if (!isWithin(realCwd, realResolved)) {
    throw new Error(`Path traversal denied: "${resolved}" is outside working directory "${cwd}"`);
  }
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ToolImplementations {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  runShell(command: string): Promise<ShellResult>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, filePath: string): Promise<string>;
  listFiles(dirPath: string): Promise<string[]>;
}

export function createToolImplementations(
  tracker: FileTracker,
  cwd: string,
  sandboxPolicy: SandboxPolicy = 'cwd-only',
  signal?: AbortSignal,
): ToolImplementations {
  const confine = sandboxPolicy === 'cwd-only';

  return {
    async readFile(filePath: string): Promise<string> {
      const resolved = path.resolve(cwd, filePath);
      if (confine) await assertWithinCwd(cwd, resolved);
      return fs.readFile(resolved, 'utf-8');
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      const resolved = path.resolve(cwd, filePath);
      if (confine) await assertWithinCwd(cwd, resolved);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      tracker.trackWrite(resolved);
    },

    async runShell(command: string): Promise<ShellResult> {
      if (confine) {
        throw new Error('runShell is disabled under sandboxPolicy "cwd-only". Use readFile, writeFile, grep, glob, or listFiles instead.');
      }
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return { stdout: '', stderr: 'Aborted', exitCode: 130 };
        }
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          exitCode: typeof err.code === 'number' ? err.code : 1,
        };
      }
    },

    async glob(pattern: string): Promise<string[]> {
      try {
        const results: string[] = [];
        const realCwd = confine ? await fs.realpath(cwd) : null;
        for await (const entry of fsGlob(pattern, { cwd })) {
          if (realCwd) {
            const abs = path.resolve(cwd, entry);
            let real: string;
            try {
              real = await fs.realpath(abs);
            } catch {
              real = abs;
            }
            if (!isWithin(realCwd, real)) continue;
          }
          results.push(entry);
        }
        return results.sort();
      } catch {
        return [];
      }
    },

    async grep(pattern: string, filePath: string): Promise<string> {
      const resolved = path.resolve(cwd, filePath);
      if (confine) await assertWithinCwd(cwd, resolved);
      try {
        const { stdout } = await execAsync(
          `grep -n -e '${pattern.replace(/'/g, "'\\''")}'  '${resolved.replace(/'/g, "'\\''")}'`,
          { signal },
        );
        return stdout.trim();
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        // grep exit 1 = no matches (normal), exit 2+ = real error
        if (err.code === 1) return '';
        throw new Error(err.stderr?.trim() || `grep failed with exit code ${err.code}`);
      }
    },

    async listFiles(dirPath: string): Promise<string[]> {
      const resolved = path.resolve(cwd, dirPath);
      if (confine) await assertWithinCwd(cwd, resolved);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
    },
  };
}
