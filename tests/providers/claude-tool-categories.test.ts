import { describe, it, expect } from 'vitest';
import {
  CLAUDE_WRITE_TOOLS,
  CLAUDE_SHELL_TOOLS,
  classifyClaudeToolCall,
} from '../../packages/core/src/providers/claude-tool-categories.js';

describe('claude-tool-categories (A5.3)', () => {
  it('CLAUDE_WRITE_TOOLS contains Write/Edit/MultiEdit/NotebookEdit', () => {
    expect(CLAUDE_WRITE_TOOLS.has('Write')).toBe(true);
    expect(CLAUDE_WRITE_TOOLS.has('Edit')).toBe(true);
    expect(CLAUDE_WRITE_TOOLS.has('MultiEdit')).toBe(true);
    expect(CLAUDE_WRITE_TOOLS.has('NotebookEdit')).toBe(true);
    expect(CLAUDE_WRITE_TOOLS.has('Read')).toBe(false);
    expect(CLAUDE_WRITE_TOOLS.has('Bash')).toBe(false);
  });

  it('CLAUDE_SHELL_TOOLS contains Bash', () => {
    expect(CLAUDE_SHELL_TOOLS.has('Bash')).toBe(true);
    expect(CLAUDE_SHELL_TOOLS.has('Write')).toBe(false);
  });

  it('classifyClaudeToolCall: Write returns writtenPath, not shell', () => {
    expect(classifyClaudeToolCall('Write', { file_path: '/x.ts' })).toEqual({ writtenPath: '/x.ts', isShell: false });
  });

  it('classifyClaudeToolCall: NotebookEdit returns notebook_path as writtenPath', () => {
    expect(classifyClaudeToolCall('NotebookEdit', { notebook_path: '/n.ipynb' })).toEqual({ writtenPath: '/n.ipynb', isShell: false });
  });

  it('classifyClaudeToolCall: Bash returns no writtenPath, isShell true', () => {
    expect(classifyClaudeToolCall('Bash', { command: 'ls' })).toEqual({ writtenPath: null, isShell: true });
  });

  it('classifyClaudeToolCall: Read returns no writtenPath, not shell', () => {
    expect(classifyClaudeToolCall('Read', { file_path: '/x.ts' })).toEqual({ writtenPath: null, isShell: false });
  });

  it('classifyClaudeToolCall: missing input returns nulls/false', () => {
    expect(classifyClaudeToolCall('Write', null)).toEqual({ writtenPath: null, isShell: false });
    expect(classifyClaudeToolCall('Write', undefined)).toEqual({ writtenPath: null, isShell: false });
  });
});

/**
 * The confinement hook must confine exactly what the reporter counts as a write.
 *
 * `claude-tool-categories.ts` opens by calling itself "single source of truth for how Claude
 * SDK tool names map to file activity", and names its two consumers — `claude-session.ts` and
 * `normalize-claude.ts` — so they "CAN'T disagree". There was a third: the sandbox hook in
 * `claude-cwd-confinement.ts` kept a private `WRITE_TOOLS` set spelling out the same four
 * names, and the drift it allows is one-directional and unsafe. Adding a write tool here (so
 * the engine reports the file as written, and the auto-commit driver picks it up) without
 * adding it there leaves the tool UNCONFINED: a `cwd-only` task writes outside the workspace,
 * and a `read-only` task writes at all.
 *
 * The security-critical copy was the one nothing bound.
 */
describe('claude write-tool classification has ONE definition', () => {
  it('read-only confinement denies exactly the tools classified as writes, and no others', async () => {
    const { evaluateReadOnly } = await import('../../packages/core/src/providers/claude-cwd-confinement.js');
    const denied = (tool: string) =>
      JSON.stringify(evaluateReadOnly(tool, { file_path: '/x.ts' })).includes('deny');

    for (const tool of CLAUDE_WRITE_TOOLS) {
      expect(denied(tool), `${tool} is classified as a write but read-only lets it through`).toBe(true);
    }
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) {
      expect(denied(tool), `${tool} is not a write but read-only denies it`).toBe(false);
    }
  });

  it('names the denied tools from the shared set rather than restating them in prose', async () => {
    const { evaluateReadOnly } = await import('../../packages/core/src/providers/claude-cwd-confinement.js');
    const message = JSON.stringify(evaluateReadOnly('Write', { file_path: '/x.ts' }));
    // A message listing four names by hand is a fifth copy: it goes stale silently, and it is
    // the only description of the rule the worker ever reads.
    for (const tool of CLAUDE_WRITE_TOOLS) {
      expect(message, `the denial message never mentions ${tool}`).toContain(tool);
    }
  });
});
