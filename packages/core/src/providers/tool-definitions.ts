import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep, dirname, basename } from 'node:path';
import { glob as fsGlob } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './runner-shell-types.js';
import { CWDValidator } from '../identity/cwd-validator.js';
import { SSRFGuard } from '../identity/ssrf-guard.js';
import { HostAllowlist } from '../identity/host-allowlist.js';

const execAsync = promisify(exec);

const MAX_READ_FILE_BYTES = 50 * 1024 * 1024;
const MAX_WRITE_FILE_BYTES = 100 * 1024 * 1024;

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

async function resolveReal(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    const realParent = await resolveReal(parent);
    return resolve(realParent, basename(target));
  }
}

async function assertWithinCwd(cwd: string, resolved: string): Promise<void> {
  const realCwd = await realpath(cwd);
  const realResolved = await resolveReal(resolved);
  if (!isWithin(realCwd, realResolved)) {
    throw new Error(`Path traversal denied: "${resolved}" is outside working directory "${cwd}"`);
  }
}

export function makeToolDefinitions(opts: {
  cwd: string;
  allowedHosts?: Set<string>;
}): ToolDefinition[] {
  const cwdValidator = new CWDValidator(opts.cwd);
  const ssrfGuard = new SSRFGuard();
  const hostAllowlist = opts.allowedHosts ? new HostAllowlist(opts.allowedHosts) : undefined;

  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 file (cwd-only)',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async (input: any) => {
        const safe = cwdValidator.validate(input.path);
        const stats = await stat(safe);
        if (stats.size > MAX_READ_FILE_BYTES) {
          throw new Error(`File too large: ${input.path} is ${stats.size} bytes (max ${MAX_READ_FILE_BYTES})`);
        }
        return { contents: await readFile(safe, 'utf8') };
      },
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 file (cwd-only)',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: async (input: any) => {
        const safe = cwdValidator.validate(input.path);
        if (input.content.length > MAX_WRITE_FILE_BYTES) {
          throw new Error(`Content too large: ${input.content.length} bytes (max ${MAX_WRITE_FILE_BYTES})`);
        }
        await mkdir(dirname(safe), { recursive: true });
        await writeFile(safe, input.content, 'utf8');
        return { written: true };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace a unique string in an existing file (cwd-only)',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldContent: { type: 'string' },
          newContent: { type: 'string' },
        },
        required: ['path', 'oldContent', 'newContent'],
      },
      execute: async (input: any) => {
        const safe = cwdValidator.validate(input.path);
        const existing = await readFile(safe, 'utf8');
        const firstIndex = existing.indexOf(input.oldContent);
        if (firstIndex === -1) {
          throw new Error(`oldContent not found in file "${input.path}"`);
        }
        const secondIndex = existing.indexOf(input.oldContent, firstIndex + input.oldContent.length);
        if (secondIndex !== -1) {
          throw new Error(
            `oldContent matches multiple locations in "${input.path}" — provide more surrounding context for a unique match`,
          );
        }
        const updated =
          existing.slice(0, firstIndex) +
          input.newContent +
          existing.slice(firstIndex + input.oldContent.length);
        if (updated.length > MAX_WRITE_FILE_BYTES) {
          throw new Error(`Edited content too large: ${updated.length} bytes (max ${MAX_WRITE_FILE_BYTES})`);
        }
        await writeFile(safe, updated, 'utf8');
        return { edited: true };
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern (cwd-only)',
      schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      execute: async (input: any) => {
        const results: string[] = [];
        const realCwd = await realpath(opts.cwd);
        for await (const entry of fsGlob(input.pattern, { cwd: opts.cwd })) {
          const abs = resolve(opts.cwd, entry);
          let real: string;
          try {
            real = await realpath(abs);
          } catch {
            real = abs;
          }
          if (!isWithin(realCwd, real)) continue;
          results.push(entry);
        }
        return { matches: results.sort() };
      },
    },
    {
      name: 'grep',
      description: 'Search for a regex pattern in a file or directory (cwd-only)',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern', 'path'],
      },
      execute: async (input: any) => {
        const safe = cwdValidator.validate(input.path);
        let isDirectory = false;
        try {
          const stats = await stat(safe);
          isDirectory = stats.isDirectory();
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            throw new Error(`grep target does not exist: ${input.path}`);
          }
          throw err;
        }
        const flags = isDirectory ? '-rn' : '-n';
        const escapedPattern = input.pattern.replace(/'/g, "'\\''");
        const escapedPath = safe.replace(/'/g, "'\\''");
        try {
          const { stdout } = await execAsync(
            `grep ${flags} -e '${escapedPattern}' '${escapedPath}'`,
            { maxBuffer: 4 * 1024 * 1024 },
          );
          return { output: stdout.trim() };
        } catch (err: any) {
          if (err.code === 1) return { output: '' };
          throw new Error(err.stderr?.trim() || `grep failed with exit code ${err.code}`);
        }
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories at the given path (cwd-only)',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      execute: async (input: any) => {
        const target = input.path ?? '.';
        const safe = cwdValidator.validate(target);
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(safe, { withFileTypes: true });
        return {
          entries: entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort(),
        };
      },
    },
    {
      name: 'run_shell',
      description: 'Execute a shell command (cwd-confined)',
      schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async (input: any) => {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: opts.cwd,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (err: any) {
          return {
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
            exitCode: typeof err.code === 'number' ? err.code : 1,
          };
        }
      },
    },
    {
      name: 'web_fetch',
      description: 'Fetch a URL (SSRF-guarded; HostAllowlist when configured)',
      schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      execute: async (input: any) => {
        ssrfGuard.check(input.url);
        if (hostAllowlist) hostAllowlist.check(new URL(input.url).hostname);
        const r = await fetch(input.url);
        return { status: r.status, body: await r.text() };
      },
    },
  ];
}
