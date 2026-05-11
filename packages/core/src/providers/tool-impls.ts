// v4.4 — sandbox-confined tool implementations for the OpenAI + Codex
// providers (which run through @openai/agents). Ported from 3.12.7's
// `tools/definitions.ts` minus the FileTracker dependency — in v4.4 the
// SDK reports tool calls itself via `runResult.history`, and the
// normalize-openai-agents.ts module extracts `filesRead`/`filesWritten`
// counts from there.
//
// Anthropic / Claude path does NOT use this — claude-agent-sdk ships its
// own sandboxed Read/Edit/Write/Bash/Grep/Glob tools (configured via the
// `cwd` option on query()).

import fs from 'fs/promises';
import { glob as fsGlob } from 'node:fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Hard caps to keep an LLM sub-agent from exhausting host memory/disk.
// Identical to the 3.12.7 values; see the historical reasoning there.
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
    const parent = path.dirname(target);
    if (parent === target) return target;
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
  editFile(filePath: string, oldContent: string, newContent: string): Promise<void>;
  runShell(command: string): Promise<ShellResult>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, target: string): Promise<string>;
  listFiles(dirPath: string): Promise<string[]>;
}

/** Adapter-facing tool IDs (snake_case). Used by tool-mode filtering. */
export const READONLY_TOOL_IDS = ['read_file', 'grep', 'glob', 'list_files'] as const;

export interface CreateToolImplsOpts {
  cwd: string;
  signal?: AbortSignal;
}

export function createToolImplementations(opts: CreateToolImplsOpts): ToolImplementations {
  const { cwd, signal } = opts;

  return {
    async readFile(filePath: string): Promise<string> {
      const resolved = path.resolve(cwd, filePath);
      await assertWithinCwd(cwd, resolved);
      const stats = await fs.stat(resolved);
      if (stats.size > MAX_READ_FILE_BYTES) {
        throw new Error(`File too large: ${filePath} is ${stats.size} bytes (max ${MAX_READ_FILE_BYTES})`);
      }
      return await fs.readFile(resolved, 'utf-8');
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      const resolved = path.resolve(cwd, filePath);
      await assertWithinCwd(cwd, resolved);
      if (content.length > MAX_WRITE_FILE_BYTES) {
        throw new Error(`Content too large: ${content.length} bytes (max ${MAX_WRITE_FILE_BYTES})`);
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
    },

    async editFile(filePath: string, oldContent: string, newContent: string): Promise<void> {
      const resolved = path.resolve(cwd, filePath);
      await assertWithinCwd(cwd, resolved);
      const existing = await fs.readFile(resolved, 'utf-8');
      const firstIndex = existing.indexOf(oldContent);
      if (firstIndex === -1) {
        throw new Error(`oldContent not found in file "${filePath}"`);
      }
      const secondIndex = existing.indexOf(oldContent, firstIndex + oldContent.length);
      if (secondIndex !== -1) {
        throw new Error(
          `oldContent matches multiple locations in "${filePath}" — provide more surrounding context for a unique match`,
        );
      }
      const updated = existing.slice(0, firstIndex) + newContent + existing.slice(firstIndex + oldContent.length);
      if (updated.length > MAX_WRITE_FILE_BYTES) {
        throw new Error(`Edited content too large: ${updated.length} bytes (max ${MAX_WRITE_FILE_BYTES})`);
      }
      await fs.writeFile(resolved, updated, 'utf-8');
    },

    async runShell(command: string): Promise<ShellResult> {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          ...(signal && { signal }),
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { name?: string; stdout?: string; stderr?: string; code?: number };
        if (e.name === 'AbortError') return { stdout: '', stderr: 'Aborted', exitCode: 130 };
        return {
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    },

    async glob(pattern: string): Promise<string[]> {
      try {
        const results: string[] = [];
        const realCwd = await fs.realpath(cwd);
        for await (const entry of fsGlob(pattern, { cwd })) {
          const abs = path.resolve(cwd, entry);
          let real: string;
          try { real = await fs.realpath(abs); } catch { real = abs; }
          if (!isWithin(realCwd, real)) continue;
          results.push(entry);
        }
        return results.sort();
      } catch {
        return [];
      }
    },

    async grep(pattern: string, target: string): Promise<string> {
      const resolved = path.resolve(cwd, target);
      await assertWithinCwd(cwd, resolved);
      let isDirectory = false;
      try {
        const stats = await fs.stat(resolved);
        isDirectory = stats.isDirectory();
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'ENOENT') throw new Error(`grep target does not exist: ${target}`);
        throw err;
      }
      const flags = isDirectory ? '-rn' : '-n';
      const escapedPattern = pattern.replace(/'/g, "'\\''");
      const escapedPath = resolved.replace(/'/g, "'\\''");
      try {
        const { stdout } = await execAsync(
          `grep ${flags} -e '${escapedPattern}' '${escapedPath}'`,
          { maxBuffer: GREP_CHILD_BUFFER_BYTES, ...(signal && { signal }) },
        );
        let output = stdout.trim();
        if (output.length > MAX_GREP_OUTPUT_BYTES) {
          const truncated = output.slice(0, MAX_GREP_OUTPUT_BYTES);
          const remaining = output.slice(MAX_GREP_OUTPUT_BYTES);
          const droppedLines = remaining.split('\n').length;
          output = `${truncated}\n[grep output truncated: ${droppedLines}+ more lines dropped. Refine your pattern or narrow the search path.]`;
        }
        return output;
      } catch (err: unknown) {
        const e = err as { name?: string; code?: number | string; stderr?: string; message?: string };
        if (e.name === 'AbortError') throw err;
        if (e.code === 1) return '';
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/.test(e.message ?? '')) {
          throw new Error(
            `grep output exceeded ${GREP_CHILD_BUFFER_BYTES} bytes before truncation. Refine your pattern or narrow the search path.`,
          );
        }
        throw new Error(e.stderr?.trim() || `grep failed with exit code ${e.code}`);
      }
    },

    async listFiles(dirPath: string): Promise<string[]> {
      const resolved = path.resolve(cwd, dirPath);
      await assertWithinCwd(cwd, resolved);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
    },
  };
}
