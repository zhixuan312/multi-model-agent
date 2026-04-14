import { describe, it, expect, vi } from 'vitest';
import { createOpenAITools } from '../../packages/core/src/tools/openai-adapter.js';
import type { ToolImplementations } from '../../packages/core/src/tools/definitions.js';

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

describe('createOpenAITools', () => {
  it('full mode returns all file tools (sandbox none)', () => {
    const tools = createOpenAITools(mockToolImpls(), 'none', 'full');
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('list_files');
  });

  it('full mode with cwd-only sandbox includes run_shell', () => {
    // shell access is controlled by toolMode, not sandboxPolicy
    const tools = createOpenAITools(mockToolImpls(), 'cwd-only', 'full');
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
  });

  it('no-shell mode excludes run_shell', () => {
    const tools = createOpenAITools(mockToolImpls(), 'cwd-only', 'no-shell');
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('run_shell');
  });

  it('readonly mode returns only read tools', () => {
    const tools = createOpenAITools(mockToolImpls(), 'cwd-only', 'readonly');
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'grep', 'glob', 'list_files']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_shell');
    expect(names).toHaveLength(4);
  });

  it('none mode returns empty array', () => {
    const tools = createOpenAITools(mockToolImpls(), 'cwd-only', 'none');
    expect(tools).toHaveLength(0);
  });
});
