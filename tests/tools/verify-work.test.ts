import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyWorkSchema, registerVerifyWork } from '@zhixuan92/multi-model-agent-mcp/tools/verify-work';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

// --- Schema tests ---

describe('verify_work schema', () => {
  it('accepts work with checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done', checklist: ['item1'] }).success).toBe(true);
  });
  it('accepts filePaths without work', () => {
    expect(verifyWorkSchema.safeParse({ filePaths: ['a.ts'], checklist: ['check'] }).success).toBe(true);
  });
  it('rejects empty checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done', checklist: [] }).success).toBe(false);
  });
  it('rejects missing checklist', () => {
    expect(verifyWorkSchema.safeParse({ work: 'done' }).success).toBe(false);
  });
  it('accepts common fields', () => {
    expect(verifyWorkSchema.safeParse({ work: 'x', checklist: ['c'], cwd: '/tmp', tools: 'readonly' }).success).toBe(true);
  });
  it('allows both work and filePaths absent (handler validates)', () => {
    expect(verifyWorkSchema.safeParse({ checklist: ['c'] }).success).toBe(true);
  });
});

// --- Handler tests ---

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', () => ({ runTasks: vi.fn() }));
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
const mockRunTasks = vi.mocked(runTasks);

function mockResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'verify output', status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, durationMs: 5000, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [],
    workerStatus: 'done', specReviewStatus: 'approved', qualityReviewStatus: 'not_run',
    ...overrides,
  };
}

function captureTool() {
  let handler: Function;
  const mockServer = { tool: (_n: string, _d: string, _s: any, h: Function) => { handler = h; } };
  return { mockServer, getHandler: () => handler! };
}

describe('verify_work handler', () => {
  beforeEach(() => { mockRunTasks.mockReset(); });

  it('rejects when neither work nor filePaths provided', async () => {
    const { mockServer, getHandler } = captureTool();
    registerVerifyWork(mockServer as any, {} as any);
    const result = await getHandler()({ checklist: ['check'] });
    expect(result.isError).toBe(true);
  });

  it('single-task mode with inline work', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerVerifyWork(mockServer as any, {} as any);

    const result = await getHandler()({ work: 'implemented feature X', checklist: ['has tests', 'handles errors'], cwd: '/proj' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toContain('implemented feature X');
    expect(tasks[0].prompt).toContain('1. has tests');
    expect(tasks[0].prompt).toContain('2. handles errors');
    expect(tasks[0].cwd).toBe('/proj');
    expect(tasks[0].reviewPolicy).toBe('spec_only');
    expect(tasks[0].agentType).toBe('standard');
    expect(result.content).toHaveLength(2);
  });

  it('fan-out mode: each file verified against same checklist', async () => {
    mockRunTasks.mockResolvedValue([mockResult(), mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerVerifyWork(mockServer as any, {} as any);

    const result = await getHandler()({ filePaths: ['a.ts', 'b.ts'], checklist: ['compiles', 'tested'] });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(2);
    expect(tasks[0].prompt).toContain('a.ts');
    expect(tasks[0].prompt).toContain('1. compiles');
    expect(tasks[1].prompt).toContain('b.ts');
    expect(tasks[1].prompt).toContain('1. compiles');
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.mode).toBe('fan_out');
  });
});
