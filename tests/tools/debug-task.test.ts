import { describe, it, expect, vi, beforeEach } from 'vitest';
import { debugTaskSchema, registerDebugTask } from '@zhixuan92/multi-model-agent-mcp/tools/debug-task';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

// --- Schema tests ---

describe('debug_task schema', () => {
  it('accepts problem with defaults', () => {
    expect(debugTaskSchema.safeParse({ problem: 'bug' }).success).toBe(true);
  });
  it('rejects missing problem', () => {
    expect(debugTaskSchema.safeParse({ context: 'ctx' }).success).toBe(false);
  });
});

// --- Handler tests ---

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', () => ({ runTasks: vi.fn() }));
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
const mockRunTasks = vi.mocked(runTasks);

function mockResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'debug output', status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, durationMs: 5000, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [],
    workerStatus: 'done', specReviewStatus: 'skipped', qualityReviewStatus: 'skipped',
    ...overrides,
  };
}

function captureTool() {
  let handler: Function;
  const mockServer = { tool: (_n: string, _d: string, _s: any, h: Function) => { handler = h; } };
  return { mockServer, getHandler: () => handler! };
}

describe('debug_task handler', () => {
  beforeEach(() => { mockRunTasks.mockReset(); });

  it('always dispatches 1 task even with multiple filePaths', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, {} as any);

    const result = await getHandler()({
      problem: 'crash on startup',
      filePaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    });

    expect(mockRunTasks).toHaveBeenCalledTimes(1);
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toContain('crash on startup');
    expect(tasks[0].prompt).toContain('a.ts');
    expect(tasks[0].prompt).toContain('e.ts');
    // Always single-task response (2 content blocks), never fan-out
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe('debug output');
  });

  it('propagates parentModel from config into task spec', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    await getHandler()({ problem: 'bug' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].parentModel).toBe('claude-opus-4-6');
  });

  it('headline reflects saved cost when parentModel is configured', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10, savedCostUSD: 0.08 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    const result = await getHandler()({ problem: 'bug' });
    const meta = JSON.parse(result.content[1].text);
    expect(meta.headline).toContain('$0.08 saved vs claude-opus-4-6');
    expect(meta.headline).not.toContain('$0.00 saved');
  });

  it('headline shows actual cost when parentModel is absent', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, { defaults: {} } as any);

    const result = await getHandler()({ problem: 'bug' });
    const meta = JSON.parse(result.content[1].text);
    expect(meta.headline).toContain('$0.10 actual');
    expect(meta.headline).not.toContain('saved vs');
  });

  it('uses correct preset: complex, full review, 1 round', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, {} as any);

    await getHandler()({ problem: 'bug' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].agentType).toBe('complex');
    expect(tasks[0].reviewPolicy).toBe('full');
    expect(tasks[0].maxReviewRounds).toBe(1);
  });

  it('includes context and hypothesis in prompt', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, {} as any);

    await getHandler()({ problem: 'OOM', context: 'after upgrade', hypothesis: 'memory leak in cache' });
    const prompt = mockRunTasks.mock.calls[0][0][0].prompt;
    expect(prompt).toContain('OOM');
    expect(prompt).toContain('after upgrade');
    expect(prompt).toContain('memory leak in cache');
  });

  it('returns metadata block with usage info', async () => {
    mockRunTasks.mockResolvedValue([mockResult({ usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUSD: 0.05 } })]);
    const { mockServer, getHandler } = captureTool();
    registerDebugTask(mockServer as any, {} as any);

    const result = await getHandler()({ problem: 'bug' });
    const meta = JSON.parse(result.content[1].text);
    expect(meta.usage.costUSD).toBe(0.05);
    expect(meta.usage.inputTokens).toBe(500);
  });
});