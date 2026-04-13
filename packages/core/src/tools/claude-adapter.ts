import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolImplementations } from './definitions.js';
import type { SandboxPolicy, ToolMode } from '../types.js';
import { READONLY_TOOL_IDS } from './definitions.js';

export function createClaudeToolServer(
  impl: ToolImplementations,
  sandboxPolicy: SandboxPolicy = 'cwd-only',
  toolMode: ToolMode = 'full',
) {
  if (toolMode === 'none') return null;

  const readFile = tool(
    'read_file',
    'Read the contents of a file at the given path. Returns the full file content as a string.',
    { path: z.string().describe('Absolute or relative file path') },
    async ({ path }) => ({
      content: [{ type: 'text' as const, text: await impl.readFile(path) }],
    }),
  );

  const writeFile = tool(
    'write_file',
    'Write content to a file, creating parent directories if needed. Overwrites existing files.',
    {
      path: z.string().describe('File path to write to'),
      content: z.string().describe('Content to write'),
    },
    async ({ path, content }) => {
      await impl.writeFile(path, content);
      return { content: [{ type: 'text' as const, text: `File written: ${path}` }] };
    },
  );

  const editFile = tool(
    'edit_file',
    'Replace a unique string in an existing file. Use this instead of write_file ' +
      'when you need to change a specific part of a file without rewriting the whole thing. ' +
      'oldContent must match exactly one location in the file \u2014 include enough surrounding ' +
      'context (nearby lines) to make it unique.',
    {
      path: z.string().describe('File path to edit'),
      oldContent: z.string().describe('Exact string to find (must be unique in file)'),
      newContent: z.string().describe('Replacement string'),
    },
    async ({ path, oldContent, newContent }) => {
      await impl.editFile(path, oldContent, newContent);
      return { content: [{ type: 'text' as const, text: `File edited: ${path}` }] };
    },
  );

  const runShell = tool(
    'run_shell',
    'Execute a shell command and return stdout, stderr, and exit code. Use for running tests, installing packages, etc.',
    { command: z.string().describe('Shell command to execute') },
    async ({ command }) => {
      const result = await impl.runShell(command);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  const globTool = tool(
    'glob',
    'Find files matching a glob pattern in the working directory.',
    { pattern: z.string().describe('Glob pattern (e.g., "*.ts", "src/**/*.js")') },
    async ({ pattern }) => {
      const files = await impl.glob(pattern);
      return { content: [{ type: 'text' as const, text: files.join('\n') || 'No files found.' }] };
    },
  );

  const grepTool = tool(
    'grep',
    'Search for a regex pattern in a file or directory. When given a directory, ' +
      'recursively searches all files (output is prefixed with file:line). When given ' +
      'a single file, returns matching lines with line numbers. Use this — not multiple ' +
      'readFile calls — to find usages, imports, or patterns across a codebase.',
    {
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().describe('File OR directory path. Directories are searched recursively.'),
    },
    async ({ pattern, path }) => {
      const result = await impl.grep(pattern, path);
      return { content: [{ type: 'text' as const, text: result || 'No matches found.' }] };
    },
  );

  const listFiles = tool(
    'list_files',
    'List files and directories at the given path. Directories have a trailing "/".',
    { path: z.string().describe('Directory path to list').default('.') },
    async ({ path }) => {
      const entries = await impl.listFiles(path);
      return { content: [{ type: 'text' as const, text: entries.join('\n') || 'Empty directory.' }] };
    },
  );

  const allTools = [
    readFile, writeFile, editFile, globTool, grepTool, listFiles,
    ...(sandboxPolicy !== 'cwd-only' ? [runShell] : []),
  ];

  const filteredTools = toolMode === 'readonly'
    ? allTools.filter(t => (READONLY_TOOL_IDS as readonly string[]).includes(t.name))
    : allTools;

  return createSdkMcpServer({
    name: 'code-tools',
    version: '1.0.0',
    tools: filteredTools,
  });
}
