import { describe, it, expect } from 'vitest';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

// A4b.0 — runner-shell must dedupe filesRead / filesWritten by unique path.
// Tool-call counts (raw activity) remain non-deduped.
//
// Bug observed live during A1.1 dispatch (2026-05-10): running headline
// reported "13 read, 10 write" for a task that touched 3 unique files,
// because runner-shell appends every write_file call to a plain string[].
// Spec reviewer mis-counted, partial cause of A1.1's spurious rejection.

describe('A4b.0 — runner-shell dedupes filesRead / filesWritten by path', () => {
  const writeTool = {
    name: 'write_file',
    description: 'write file',
    schema: {},
    execute: async () => ({ ok: true }),
  };
  const readTool = {
    name: 'read_file',
    description: 'read file',
    schema: {},
    execute: async () => ({ ok: true }),
  };

  it('5 write_file calls to the same path → filesWritten length === 1', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/foo.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/foo.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/foo.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/foo.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'src/foo.ts' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [writeTool],
      maxTurns: 10, cwd: '/tmp',
    });
    expect(result.filesWritten).toEqual(['src/foo.ts']);
    expect(result.toolCalls).toHaveLength(5);
  });

  it('3 read_file calls to the same path → filesRead length === 1', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'read_file', input: { path: 'plan.md' } }] },
        { assistantText: '', toolCalls: [{ name: 'read_file', input: { path: 'plan.md' } }] },
        { assistantText: '', toolCalls: [{ name: 'read_file', input: { path: 'plan.md' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [readTool],
      maxTurns: 10, cwd: '/tmp',
    });
    expect(result.filesRead).toEqual(['plan.md']);
    expect(result.toolCalls).toHaveLength(3);
  });

  it('writes to two different paths → filesWritten length === 2', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'a.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'b.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'a.ts' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [writeTool],
      maxTurns: 10, cwd: '/tmp',
    });
    expect(result.filesWritten.sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.toolCalls).toHaveLength(3);
  });

  it('mixed reads + writes dedupe independently', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: '', toolCalls: [{ name: 'read_file', input: { path: 'a.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'a.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'read_file', input: { path: 'a.ts' } }] },
        { assistantText: '', toolCalls: [{ name: 'write_file', input: { path: 'a.ts' } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: '', userMessage: '',
      toolDefinitions: [readTool, writeTool],
      maxTurns: 10, cwd: '/tmp',
    });
    expect(result.filesRead).toEqual(['a.ts']);
    expect(result.filesWritten).toEqual(['a.ts']);
    expect(result.toolCalls).toHaveLength(4);
  });
});
