import { describe, it, expect } from 'vitest';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

/**
 * A4b §2a (4.2.2+) — runner-shell must NOT include `shell:`-prefixed
 * synthetic entries in the public `filesWritten` array. They were
 * introduced by Gap-11 (4.0.3) to make the headline show non-zero write
 * activity for shell-bypass workers, but they pollute the spec
 * reviewer's "what changed?" reasoning. After this fix:
 *
 *   - `result.filesWritten` carries ONLY real, validated relative paths.
 *   - `result.filesWrittenRejected` carries the shell-channel entries
 *     for diagnostic logging (lifecycle drains this into
 *     `LifecycleContext.diagnostics.filesWrittenRejected` per §2a).
 *   - The headline's `shellWrites` counter (separate code path on the
 *     sink) continues to count shell-attempted writes — that's the
 *     "shell tried to write" signal, distinct from "real artifact
 *     produced".
 */
describe('A4b.1 — runner-shell filters shell entries out of filesWritten', () => {
  const writeTool = {
    name: 'write_file',
    description: 'write file',
    schema: {},
    execute: async () => ({ ok: true }),
  };
  const runShellTool = {
    name: 'run_shell',
    description: 'run shell',
    schema: {},
    execute: async () => ({ ok: true, stdout: '' }),
  };

  it('shell heredoc to a file → filesWritten is empty; entry lands on filesWrittenRejected', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'run_shell', input: { command: 'cat > src/foo.ts << EOF\nexport {};\nEOF' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [runShellTool],
      maxTurns: 5, cwd: '/tmp',
    });
    expect(result.filesWritten).toEqual([]);
    expect(result.filesWrittenRejected).toBeDefined();
    expect(result.filesWrittenRejected!.length).toBeGreaterThan(0);
    expect(result.filesWrittenRejected![0]).toMatch(/^shell:/);
  });

  it('mix of real write + shell heredoc → filesWritten has only the real path', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/real.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'run_shell', input: { command: 'cat > src/shelled.ts << EOF\nx\nEOF' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [writeTool, runShellTool],
      maxTurns: 5, cwd: '/tmp',
    });
    expect(result.filesWritten).toEqual(['src/real.ts']);
    expect(result.filesWrittenRejected).toBeDefined();
    expect(result.filesWrittenRejected!.some(s => s.startsWith('shell:'))).toBe(true);
  });

  it('absolute paths are rejected (sandbox-escape guard)', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: '/etc/passwd' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [writeTool],
      maxTurns: 5, cwd: '/tmp',
    });
    expect(result.filesWritten).toEqual([]);
    expect(result.filesWrittenRejected).toContain('/etc/passwd');
  });

  it('valid relative path passes through (no regression)', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'packages/core/src/foo.ts' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [writeTool],
      maxTurns: 5, cwd: '/tmp',
    });
    expect(result.filesWritten).toEqual(['packages/core/src/foo.ts']);
    expect(result.filesWrittenRejected ?? []).toEqual([]);
  });
});
