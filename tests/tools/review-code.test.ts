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
  it('allows both absent (handler validates)', () => {
    expect(reviewCodeSchema.safeParse({}).success).toBe(true);
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
    registerReviewCode(mockServer as any, { defaults: { tools: 'full', timeoutMs: 600_000, maxCostUSD: 10, sandboxPolicy: 'cwd-only' } } as any);

    const result = await getHandler()({ code: 'function foo() {}', focus: ['security'] });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toContain('function foo() {}');
    expect(tasks[0].prompt).toContain('security');
    expect(tasks[0].cwd).toBe(process.cwd());
    expect(tasks[0].reviewPolicy).toBe('full');
    expect(result.content).toHaveLength(2);
  });

  it('propagates parentModel from config into task spec (single-task)', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    await getHandler()({ code: 'fn()' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].parentModel).toBe('claude-opus-4-6');
  });

  it('propagates parentModel from config into task spec (fan-out)', async () => {
    mockRunTasks.mockResolvedValue([mockResult(), mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    await getHandler()({ filePaths: ['a.ts', 'b.ts'] });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].parentModel).toBe('claude-opus-4-6');
    expect(tasks[1].parentModel).toBe('claude-opus-4-6');
  });

  it('headline reflects saved cost when parentModel is configured (single-task)', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10, savedCostUSD: 0.08 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    const result = await getHandler()({ code: 'fn()' });
    const meta = JSON.parse(result.content[1].text);
    expect(meta.headline).toContain('$0.08 saved vs claude-opus-4-6');
    expect(meta.headline).not.toContain('$0.00 saved');
  });

  it('headline reflects saved cost when parentModel is configured (fan-out)', async () => {
    mockRunTasks.mockResolvedValue([
      mockResult({ usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, costUSD: 0.05, savedCostUSD: 0.04 } }),
      mockResult({ usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, costUSD: 0.05, savedCostUSD: 0.04 } }),
    ]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    const result = await getHandler()({ filePaths: ['a.ts', 'b.ts'] });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.headline).toContain('$0.08 saved vs claude-opus-4-6');
    expect(envelope.headline).not.toContain('$0.00 saved');
  });

  it('headline shows actual cost when parentModel is absent', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerReviewCode(mockServer as any, { defaults: {} } as any);

    const result = await getHandler()({ code: 'fn()' });
    const meta = JSON.parse(result.content[1].text);
    expect(meta.headline).toContain('$0.10 actual');
    expect(meta.headline).not.toContain('saved vs');
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
});