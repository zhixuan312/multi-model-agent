import { describe, it, expect } from 'vitest';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';

describe('RunnerShell', () => {
  it('runs the turn loop until adapter signals stop', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: 'thinking...', toolCalls: [{ name: 'noop', input: {} }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: 'sys',
      userMessage: 'hi',
      toolDefinitions: [{ name: 'noop', description: 'no-op', schema: {}, execute: async () => null }],
      maxTurns: 5,
      cwd: '/tmp',
    });
    expect(result.workerStatus).toBe('done');
    expect(result.finalAssistantText).toBe('done');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('emits canonical 4-field token usage', async () => {
    const adapter = mockAdapter({
      turns: [{ assistantText: 'done', toolCalls: [] }],
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, cachedNonReadTokens: 5 },
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({ systemPrompt: '', userMessage: '', toolDefinitions: [], maxTurns: 1, cwd: '/tmp' });
    expect(Object.keys(result.usage).sort()).toEqual(['cachedNonReadTokens', 'cachedReadTokens', 'inputTokens', 'outputTokens']);
    expect(result.usage.outputTokens).toBe(50);
  });

  it('returns blocked when maxTurns exhausted without adapter stop signal', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: 'still working...', toolCalls: [{ name: 'noop', input: {} }] },
        { assistantText: 'still working...', toolCalls: [{ name: 'noop', input: {} }] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: 'sys',
      userMessage: 'hi',
      toolDefinitions: [{ name: 'noop', description: 'no-op', schema: {}, execute: async () => null }],
      maxTurns: 2,
      cwd: '/tmp',
    });
    expect(result.workerStatus).toBe('blocked');
    expect(result.errorCode).toBe('max_turns_exhausted');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.finalAssistantText).toBe('still working...');
  });

  it('returns blocked with errorCode when maxTurns is 0', async () => {
    const adapter = mockAdapter({
      turns: [{ assistantText: 'done', toolCalls: [] }],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: 'sys',
      userMessage: 'hi',
      toolDefinitions: [],
      maxTurns: 0,
      cwd: '/tmp',
    });
    expect(result.workerStatus).toBe('blocked');
    expect(result.errorCode).toBe('max_turns_exhausted');
    expect(result.finalAssistantText).toBe('');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('records unknown-tool errors without crashing the turn loop', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: 'trying unknown tool', toolCalls: [{ name: 'nonexistent', input: { x: 1 } }] },
        { assistantText: 'done', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: 'sys',
      userMessage: 'hi',
      toolDefinitions: [{ name: 'known', description: 'known', schema: {}, execute: async () => 'ok' }],
      maxTurns: 5,
      cwd: '/tmp',
    });
    expect(result.workerStatus).toBe('done');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].result).toEqual({ error: 'unknown tool: nonexistent' });
  });

  it('catches tool execution errors without crashing the turn loop', async () => {
    const adapter = mockAdapter({
      turns: [
        { assistantText: 'trying...', toolCalls: [{ name: 'crashy', input: {} }] },
        { assistantText: 'recovered', toolCalls: [] },
      ],
    });
    const shell = new RunnerShell(adapter);
    const result = await shell.run({
      systemPrompt: 'sys',
      userMessage: 'hi',
      toolDefinitions: [{ name: 'crashy', description: 'crashes', schema: {}, execute: async () => { throw new Error('boom'); } }],
      maxTurns: 5,
      cwd: '/tmp',
    });
    expect(result.workerStatus).toBe('done');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].result).toMatchObject({ error: expect.stringContaining('tool execution failed: boom') });
  });
});
