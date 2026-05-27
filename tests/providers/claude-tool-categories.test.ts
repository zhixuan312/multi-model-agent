import { describe, it, expect } from 'bun:test';
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
