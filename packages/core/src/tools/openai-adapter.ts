import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ToolImplementations } from './definitions.js';
import { READONLY_TOOL_IDS } from './definitions.js';
import type { SandboxPolicy, ToolMode } from '../types.js';

export function createOpenAITools(
  impl: ToolImplementations,
  sandboxPolicy: SandboxPolicy = 'cwd-only',
  toolMode: ToolMode = 'full',
) {
  if (toolMode === 'none') return [];

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

  const editFile = tool({
    name: 'edit_file',
    description:
      'Replace a unique string in an existing file. Use this instead of write_file ' +
      'when you need to change a specific part of a file without rewriting the whole thing. ' +
      'oldContent must match exactly one location in the file \u2014 include enough surrounding ' +
      'context (nearby lines) to make it unique.',
    parameters: z.object({
      path: z.string().describe('File path to edit'),
      oldContent: z.string().describe('Exact string to find (must be unique in file)'),
      newContent: z.string().describe('Replacement string'),
    }),
    execute: async ({ path, oldContent, newContent }) => {
      await impl.editFile(path, oldContent, newContent);
      return `File edited: ${path}`;
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
    description:
      'Search for a regex pattern in a file or directory. When given a directory, ' +
      'recursively searches all files (output is prefixed with file:line). When given ' +
      'a single file, returns matching lines with line numbers. Use this — not multiple ' +
      'readFile calls — to find usages, imports, or patterns across a codebase.',
    parameters: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().describe('File OR directory path. Directories are searched recursively.'),
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

  const allTools = [
    readFile, writeFile, editFile, globTool, grepTool, listFiles,
    ...(sandboxPolicy !== 'cwd-only' ? [runShell] : []),
  ];

  if (toolMode === 'readonly') {
    return allTools.filter(t => (READONLY_TOOL_IDS as readonly string[]).includes(t.name));
  }

  return allTools;
}
