// Single source of truth for how Claude SDK tool names map to file activity.
// Both the live envelope (claude-session.ts) and the final TurnResult
// (normalize-claude.ts) import from here so they CAN'T disagree.

/** Claude SDK tool names that count as a write. */
export const CLAUDE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/** Claude SDK tool names that count as a shell invocation. */
export const CLAUDE_SHELL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
]);

/**
 * Given one Claude SDK tool_use block (toolName + input), return:
 *  - `writtenPath`: the file path written, or null if not a write
 *  - `isShell`: true if this tool call is a shell invocation
 *
 * Claude tool inputs use `file_path` for Read/Write/Edit/MultiEdit and
 * `notebook_path` for NotebookEdit. NotebookEdit reads-then-writes the
 * same notebook; we report it under writtenPath because the auto-commit
 * driver needs to know the path was modified.
 */
export function classifyClaudeToolCall(
  toolName: string,
  input: unknown,
): { writtenPath: string | null; isShell: boolean } {
  const isShell = CLAUDE_SHELL_TOOLS.has(toolName);
  if (!CLAUDE_WRITE_TOOLS.has(toolName)) return { writtenPath: null, isShell };
  if (typeof input !== 'object' || input === null) return { writtenPath: null, isShell };
  const inp = input as { file_path?: unknown; notebook_path?: unknown };
  const path = typeof inp.file_path === 'string' ? inp.file_path
    : typeof inp.notebook_path === 'string' ? inp.notebook_path
    : null;
  return { writtenPath: path, isShell };
}
