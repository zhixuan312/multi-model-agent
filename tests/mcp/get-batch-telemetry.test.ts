import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTasks as mockedRunTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', async () => {
  const actual = await vi.importActual<typeof import('@zhixuan92/multi-model-agent-core/run-tasks')>(
    '@zhixuan92/multi-model-agent-core/run-tasks',
  );
  return {
    ...actual,
    runTasks: vi.fn(
      async (tasks: { prompt: string }[]): Promise<RunResult[]> =>
        tasks.map((_, i) => ({
          output: `output ${i}`.repeat(50),
          status: 'ok' as const,
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            costUSD: 0.01,
            savedCostUSD: 0.08,
          },
          turns: 3,
          filesRead: [`src/f${i}.ts`],
          filesWritten: [],
          toolCalls: [`readFile src/f${i}.ts`],
          outputIsDiagnostic: false,
          escalationLog: [
            {
              provider: 'mock',
              status: 'ok' as const,
              turns: 3,
              inputTokens: 1000,
              outputTokens: 500,
              costUSD: 0.01,
              initialPromptLengthChars: 42,
              initialPromptHash: `hash-${i}`,
            },
          ],
          durationMs: 1000 + i * 100,
        })),
    ),
  };
});

const sampleConfig = (): MultiModelConfig => ({
  providers: {
    mock: {
      type: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

beforeEach(() => {
  vi.resetModules();
});

async function makeServer() {
  const { buildMcpServer } = await import('../../packages/mcp/src/cli.js');
  return buildMcpServer(sampleConfig(), { runTasksImpl: mockedRunTasks });
}

async function callTool(server: any, toolName: string, input: unknown): Promise<any> {
  const tool = server._registeredTools?.[toolName];
  if (!tool || typeof tool.handler !== 'function') {
    throw new Error(`tool ${toolName} not registered on server`);
  }
  const result = await tool.handler(input, {});
  const textPart = result.content?.[0]?.text;
  if (typeof textPart !== 'string') return result;
  try {
    return JSON.parse(textPart);
  } catch {
    return textPart;
  }
}

describe('get_batch_telemetry tool', () => {
  it('returns headline, timings, batchProgress, aggregateCost, and slim per-task rollup', async () => {
    const server = await makeServer();
    const dispatch = await callTool(server, 'delegate_tasks', {
      tasks: [
        { prompt: 't1', provider: 'mock', tier: 'standard', requiredCapabilities: [], parentModel: 'claude-opus-4-6' },
        { prompt: 't2', provider: 'mock', tier: 'standard', requiredCapabilities: [], parentModel: 'claude-opus-4-6' },
      ],
    });

    const telemetry = await callTool(server, 'get_batch_telemetry', { batchId: dispatch.batchId });

    expect(telemetry).toHaveProperty('batchId', dispatch.batchId);
    expect(telemetry).toHaveProperty('headline');
    expect(telemetry).toHaveProperty('timings');
    expect(telemetry).toHaveProperty('batchProgress');
    expect(telemetry).toHaveProperty('aggregateCost');
    expect(telemetry).toHaveProperty('results');
    expect(telemetry.results).toHaveLength(2);

    expect(telemetry.batchProgress).toEqual(dispatch.batchProgress);
    expect(telemetry.aggregateCost).toEqual(dispatch.aggregateCost);
    expect(telemetry.timings.sumOfTaskMs).toBe(dispatch.timings.sumOfTaskMs);

    expect(typeof telemetry.timings.wallClockMs).toBe('number');
    expect(telemetry.timings.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(typeof telemetry.timings.estimatedParallelSavingsMs).toBe('number');
    expect(telemetry.timings.estimatedParallelSavingsMs).toBeGreaterThanOrEqual(0);

    expect(typeof telemetry.headline).toBe('string');
    expect(telemetry.headline).toMatch(
      new RegExp(`^2 tasks, ${dispatch.batchProgress.completedTasks}/2 ok \\(${dispatch.batchProgress.successPercent.toFixed(1)}%\\)`),
    );

    const task0 = telemetry.results[0];
    expect(task0).toHaveProperty('taskIndex', 0);
    expect(task0).toHaveProperty('status');
    expect(Array.isArray(task0.escalationChain)).toBe(true);
    expect(task0).toHaveProperty('provider');
    expect(task0).toHaveProperty('turns');
    expect(task0).toHaveProperty('durationMs');
    expect(task0).toHaveProperty('usage');

    expect(task0).not.toHaveProperty('output');
    expect(task0).not.toHaveProperty('outputLength');
    expect(task0).not.toHaveProperty('outputSha256');
    expect(task0).not.toHaveProperty('toolCalls');
    expect(task0).not.toHaveProperty('filesRead');
    expect(task0).not.toHaveProperty('_fetchOutputWith');
    expect(task0).not.toHaveProperty('_fetchDetailWith');
  });

  it('envelope is under 2 KB on a 2-task batch', async () => {
    const server = await makeServer();
    const dispatch = await callTool(server, 'delegate_tasks', {
      tasks: [
        { prompt: 't1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
        { prompt: 't2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
      ],
    });

    const telemetry = await callTool(server, 'get_batch_telemetry', { batchId: dispatch.batchId });
    expect(JSON.stringify(telemetry).length).toBeLessThan(2 * 1024);
  });

  it('returns an error for an unknown batchId', async () => {
    const server = await makeServer();

    await expect(
      callTool(server, 'get_batch_telemetry', { batchId: 'nonexistent' }),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('returns byte-identical envelopes on consecutive calls (recompute consistency)', async () => {
    const server = await makeServer();
    const dispatch = await callTool(server, 'delegate_tasks', {
      tasks: [
        { prompt: 't1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
        { prompt: 't2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
      ],
    });

    const first = await callTool(server, 'get_batch_telemetry', { batchId: dispatch.batchId });
    const second = await callTool(server, 'get_batch_telemetry', { batchId: dispatch.batchId });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
