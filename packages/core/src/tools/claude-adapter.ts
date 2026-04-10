import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolImplementations } from './definitions.js';
import type { SandboxPolicy } from '../../types.js';

export function createClaudeToolServer(impl: ToolImplementations, sandboxPolicy: SandboxPolicy = 'cwd-only') {
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
    'Search for a pattern in a file. Returns matching lines with line numbers.',
    {
      pattern: z.string().describe('Search pattern (regex)'),
      path: z.string().describe('File path to search in'),
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

  return createSdkMcpServer({
    name: 'code-tools',
    version: '1.0.0',
    tools: [
      readFile, writeFile, globTool, grepTool, listFiles,
      ...(sandboxPolicy !== 'cwd-only' ? [runShell] : []),
    ],
  });
}
