import { describe, it, expect, vi } from 'vitest';
import type { ToolImplementations } from '../../packages/core/src/tools/definitions.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual('@anthropic-ai/claude-agent-sdk');
  return {
    ...actual,
    createSdkMcpServer: vi.fn((opts: any) => ({ __mock: true, tools: opts.tools })),
  };
});

import { createClaudeToolServer } from '../../packages/core/src/tools/claude-adapter.js';

function mockToolImpls(): ToolImplementations {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    runShell: vi.fn(),
    glob: vi.fn(),
    grep: vi.fn(),
    listFiles: vi.fn(),
  };
}

function getToolNames(server: any): string[] {
  return server?.tools?.map((t: any) => t.name) ?? [];
}

describe('createClaudeToolServer', () => {
  it('full mode with sandbox none includes all 6 tools', () => {
    const server = createClaudeToolServer(mockToolImpls(), 'none', 'full');
    const names = getToolNames(server);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('list_files');
  });

  it('full mode with cwd-only excludes run_shell', () => {
    const server = createClaudeToolServer(mockToolImpls(), 'cwd-only', 'full');
    const names = getToolNames(server);
    expect(names).toContain('write_file');
    expect(names).not.toContain('run_shell');
  });

  it('readonly mode returns only 4 read tools', () => {
    const server = createClaudeToolServer(mockToolImpls(), 'cwd-only', 'readonly');
    const names = getToolNames(server);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'grep', 'glob', 'list_files']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_shell');
    expect(names).toHaveLength(4);
  });

  it('none mode returns null', () => {
    const server = createClaudeToolServer(mockToolImpls(), 'cwd-only', 'none');
    expect(server).toBeNull();
  });
});