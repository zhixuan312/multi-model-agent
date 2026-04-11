import fs from 'fs/promises';
import { glob as fsGlob } from 'node:fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { FileTracker } from './tracker.js';
import type { SandboxPolicy } from '../types.js';

const execAsync = promisify(exec);

// Hard caps to keep an LLM sub-agent from exhausting host memory or disk by
// asking the file tools to read or write absurdly large blobs. The values are
// generous for normal coding work and intentionally well below the memory
// budget of a typical Node process (~1.5 GB default heap). They can be tuned
// per-deployment by editing the constants.
//
// readFile: 50 MB. Larger than any sensible source file.
// writeFile: 100 MB. Generous enough for build artefacts but caps disk-fill
//            attacks where the model is told to write a multi-gigabyte file.
// grep: 200 KB rendered output. Recursive grep on a large repo can otherwise
//       dump megabytes of matches into the model's context, which is both
//       expensive and useless. Truncating with a marker forces the worker to
//       refine its pattern.
// grep child: 4 MB stdout buffer. Process-level cap that's larger than the
//             rendered cap so we never lose a real grep result that fits
//             within the rendered limit just because of buffer overflow.
export const MAX_READ_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_WRITE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_GREP_OUTPUT_BYTES = 200 * 1024;
export const GREP_CHILD_BUFFER_BYTES = 4 * 1024 * 1024;

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
  grep(pattern: string, target: string): Promise<string>;
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
      tracker.trackToolCall(`readFile(${filePath})`);
      const resolved = path.resolve(cwd, filePath);
      if (confine) await assertWithinCwd(cwd, resolved);
      // Reject oversized files BEFORE reading them into memory. stat is
      // cheap; reading a 10 GB file would OOM the host.
      const stats = await fs.stat(resolved);
      if (stats.size > MAX_READ_FILE_BYTES) {
        throw new Error(
          `File too large: ${filePath} is ${stats.size} bytes (max ${MAX_READ_FILE_BYTES})`,
        );
      }
      const content = await fs.readFile(resolved, 'utf-8');
      tracker.trackRead(resolved);
      return content;
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      tracker.trackToolCall(`writeFile(${filePath}, ${content.length}B)`);
      const resolved = path.resolve(cwd, filePath);
      if (confine) await assertWithinCwd(cwd, resolved);
      // Reject oversized writes BEFORE touching the disk. content.length is
      // a UTF-16 code-unit count, but it's a reasonable upper bound on the
      // byte size after UTF-8 encoding for the purpose of capping abuse.
      if (content.length > MAX_WRITE_FILE_BYTES) {
        throw new Error(
          `Content too large: ${content.length} bytes (max ${MAX_WRITE_FILE_BYTES})`,
        );
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      tracker.trackWrite(resolved);
    },

    async runShell(command: string): Promise<ShellResult> {
      tracker.trackToolCall(`runShell(${command.length > 80 ? command.slice(0, 77) + '…' : command})`);
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
      tracker.trackToolCall(`glob(${pattern})`);
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

    async grep(pattern: string, target: string): Promise<string> {
      tracker.trackToolCall(`grep(${target}, "${pattern.length > 60 ? pattern.slice(0, 57) + '…' : pattern}")`);
      const resolved = path.resolve(cwd, target);
      if (confine) await assertWithinCwd(cwd, resolved);

      // Detect file vs directory so we can pick the right grep mode. ENOENT
      // is reported as a clear error so the worker doesn't think "no matches".
      let isDirectory = false;
      try {
        const stats = await fs.stat(resolved);
        isDirectory = stats.isDirectory();
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`grep target does not exist: ${target}`);
        }
        throw err;
      }

      tracker.trackRead(resolved);

      // Directory targets get recursive grep with file:line prefixes; file
      // targets keep the original line-only output for compactness.
      const flags = isDirectory ? '-rn' : '-n';
      const escapedPattern = pattern.replace(/'/g, "'\\''");
      const escapedPath = resolved.replace(/'/g, "'\\''");

      try {
        const { stdout } = await execAsync(
          `grep ${flags} -e '${escapedPattern}' '${escapedPath}'`,
          { signal, maxBuffer: GREP_CHILD_BUFFER_BYTES },
        );
        let output = stdout.trim();
        // Cap rendered output so a recursive grep over a huge repo doesn't
        // dump 200k matches into the model's context. The worker can refine
        // its pattern instead.
        if (output.length > MAX_GREP_OUTPUT_BYTES) {
          const truncated = output.slice(0, MAX_GREP_OUTPUT_BYTES);
          const remaining = output.slice(MAX_GREP_OUTPUT_BYTES);
          const droppedLines = remaining.split('\n').length;
          output = `${truncated}\n[grep output truncated: ${droppedLines}+ more lines dropped. Refine your pattern or narrow the search path.]`;
        }
        return output;
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        // grep exit 1 = no matches (normal), exit 2+ = real error
        if (err.code === 1) return '';
        // Child process buffer overflow surfaces as a stdio max-buffer error.
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/.test(err.message ?? '')) {
          throw new Error(
            `grep output exceeded ${GREP_CHILD_BUFFER_BYTES} bytes before truncation. Refine your pattern or narrow the search path.`,
          );
        }
        throw new Error(err.stderr?.trim() || `grep failed with exit code ${err.code}`);
      }
    },

    async listFiles(dirPath: string): Promise<string[]> {
      tracker.trackToolCall(`listFiles(${dirPath})`);
      const resolved = path.resolve(cwd, dirPath);
      if (confine) await assertWithinCwd(cwd, resolved);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      tracker.trackRead(resolved);
      tracker.trackDirectoryList(resolved);
      return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
    },
  };
}
