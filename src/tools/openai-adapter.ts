import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ToolImplementations } from './definitions.js';
import type { SandboxPolicy } from '../types.js';

export function createOpenAITools(impl: ToolImplementations, sandboxPolicy: SandboxPolicy = 'cwd-only') {
  const readFile = tool({
    name: 'read_file',
    description: 'Read the contents of a file at the given path. Returns the full file content as a string.',
    parameters: z.object({
      path: z.string().describe('Absolute or relative file path'),
    }),
    execute: async ({ path }) => impl.readFile(path),
  });

  const writeFile = tool({
    name: 'write_file',
    description: 'Write content to a file, creating parent directories if needed. Overwrites existing files.',
    parameters: z.object({
      path: z.string().describe('File path to write to'),
      content: z.string().describe('Content to write'),
    }),
    execute: async ({ path, content }) => {
      await impl.writeFile(path, content);
      return `File written: ${path}`;
    },
  });

  const runShell = tool({
    name: 'run_shell',
    description: 'Execute a shell command and return stdout, stderr, and exit code. Use for running tests, installing packages, etc.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    execute: async ({ command }) => {
      const result = await impl.runShell(command);
      return JSON.stringify(result);
    },
  });

  const globTool = tool({
    name: 'glob',
    description: 'Find files matching a glob pattern in the working directory.',
    parameters: z.object({
      pattern: z.string().describe('Glob pattern (e.g., "*.ts", "src/**/*.js")'),
    }),
    execute: async ({ pattern }) => {
      const files = await impl.glob(pattern);
      return files.join('\n') || 'No files found.';
    },
  });

  const grepTool = tool({
    name: 'grep',
    description: 'Search for a pattern in a file. Returns matching lines with line numbers.',
    parameters: z.object({
      pattern: z.string().describe('Search pattern (regex)'),
      path: z.string().describe('File path to search in'),
    }),
    execute: async ({ pattern, path }) => {
      const result = await impl.grep(pattern, path);
      return result || 'No matches found.';
    },
  });

  const listFiles = tool({
    name: 'list_files',
    description: 'List files and directories at the given path. Directories have a trailing "/".',
    parameters: z.object({
      path: z.string().describe('Directory path to list').default('.'),
    }),
    execute: async ({ path }) => {
      const entries = await impl.listFiles(path);
      return entries.join('\n') || 'Empty directory.';
    },
  });

  return [
    readFile, writeFile, globTool, grepTool, listFiles,
    ...(sandboxPolicy !== 'cwd-only' ? [runShell] : []),
  ];
}
