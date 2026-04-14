import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewCodeSchema, registerReviewCode } from '@zhixuan92/multi-model-agent-mcp/tools/review-code';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

// --- Schema tests ---

describe('review_code schema', () => {
  it('accepts inline code', () => {
    expect(reviewCodeSchema.safeParse({ code: 'fn()' }).success).toBe(true);
  });
  it('accepts filePaths without code', () => {
    expect(reviewCodeSchema.safeParse({ filePaths: ['a.ts'] }).success).toBe(true);
  });
  it('accepts focus array', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', focus: ['security', 'performance'] }).success).toBe(true);
  });
  it('accepts outputFormat', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', outputFormat: 'json' }).success).toBe(true);
  });
  it('accepts common fields', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', cwd: '/tmp', tools: 'readonly', contextBlockIds: ['a'] }).success).toBe(true);
  });
  it('allows both absent (handler validates)', () => {
    expect(reviewCodeSchema.safeParse({}).success).toBe(true);
  });
  it('accepts maxCostUSD', () => {
    expect(reviewCodeSchema.safeParse({ code: 'x', maxCostUSD: 0.50 }).success).toBe(true);
  });
});

// --- Handler tests ---

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', () => ({ runTasks: vi.fn() }));
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
const mockRunTasks = vi.mocked(runTasks);

function mockResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'review output', status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, durationMs: 5000, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [],
    workerStatus: 'done', specReviewStatus: 'approved', qualityReviewStatus: 'approved',
    ...overrides,
  };
}

function captureTool() {
  let handler: Function;
  const mockServer = { tool: (_n: string, _d: string, _s: any, h: Function) => { handler = h; } };
  return { mockServer, getHandler: () => handler! };
}

describe('review_code handler', () => {
  beforeEach(() => { mockRunTasks.mockReset(); });

  it('rejects when neither code nor filePaths provided', async () => {
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);
    const result = await getHandler()({});
    expect(result.isError).toBe(true);
  });

  it('single-task mode with inline code', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);

    const result = await getHandler()({ code: 'function foo() {}', focus: ['security'], cwd: '/project' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toContain('function foo() {}');
    expect(tasks[0].prompt).toContain('security');
    expect(tasks[0].cwd).toBe('/project');
    expect(tasks[0].reviewPolicy).toBe('full');
    expect(result.content).toHaveLength(2);
  });

  it('fan-out mode with multiple filePaths', async () => {
    mockRunTasks.mockResolvedValue([mockResult(), mockResult(), mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);

    const result = await getHandler()({ filePaths: ['a.ts', 'b.ts', 'c.ts'] });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(3);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.mode).toBe('fan_out');
    expect(envelope).not.toHaveProperty('batchId');
  });

  it('passes outputFormat as formatConstraints', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);
    await getHandler()({ code: 'x', outputFormat: 'json' });
    expect(mockRunTasks.mock.calls[0][0][0].formatConstraints).toEqual({ outputFormat: 'json' });
  });

  it('passes maxCostUSD through to TaskSpec', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);
    await getHandler()({ code: 'x', maxCostUSD: 0.30 });
    expect(mockRunTasks.mock.calls[0][0][0].maxCostUSD).toBe(0.30);
  });

  it('omits maxCostUSD from TaskSpec when not provided', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, {} as any);
    await getHandler()({ code: 'x' });
    expect('maxCostUSD' in mockRunTasks.mock.calls[0][0][0]).toBe(false);
  });
});
