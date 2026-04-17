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
          output: `output for task ${i}`,
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 3,
          filesRead: [`src/read-${i}.ts`, `src/also-read-${i}.ts`],
          filesWritten: [`src/wrote-${i}.ts`],
          directoriesListed: ['src'],
          toolCalls: [
            `readFile src/read-${i}.ts`,
            `grep foo → 2 hits`,
            `writeFile src/wrote-${i}.ts`,
          ],
          outputIsDiagnostic: false,
          escalationLog: [
            {
              provider: 'mock',
              status: 'ok' as const,
              turns: 3,
              inputTokens: 100,
              outputTokens: 50,
              costUSD: 0.01,
              initialPromptLengthChars: 42,
              initialPromptHash: 'abc',
              reason: undefined,
            },
          ],
          durationMs: 1000,
          workerStatus: 'done' as const,
          terminationReason: {
            cause: 'finished' as const, turnsUsed: 3, turnsAllowed: 200,
            hasFileArtifacts: true, usedShell: false,
            workerSelfAssessment: 'done' as const, wasPromoted: false,
          },
          specReviewStatus: 'approved' as const,
          qualityReviewStatus: 'approved' as const,
          agents: {
            normalizer: 'standard' as const,
            implementer: 'standard' as const,
            specReviewer: 'standard' as const,
            qualityReviewer: 'standard' as const,
          },
          implementationReport: {
            summary: 'implemented successfully',
            concerns: [],
            warnings: [],
            sections: [],
          },
          specReviewReport: {
            summary: 'spec approved',
            concerns: [],
            warnings: [],
            sections: [],
          },
          qualityReviewReport: {
            summary: 'quality approved',
            concerns: [],
            warnings: [],
            sections: [],
          },
        })),
    ),
  };
});

const sampleConfig = (): MultiModelConfig => ({
  agents: {
    standard: { type: 'openai-compatible', model: 'test-model', baseUrl: 'http://localhost:1234/v1' },
    complex: { type: 'openai-compatible', model: 'test-model-complex', baseUrl: 'http://localhost:1235/v1' },
  },
  defaults: { timeoutMs: 600000, tools: 'full' },
});

beforeEach(() => {
  vi.resetModules();
});

async function makeServer() {
  const { buildMcpServer } = await import('../../packages/mcp/src/cli.js');
  return buildMcpServer(sampleConfig(), { _testRunTasksOverride: mockedRunTasks });
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

async function dispatchFixtureBatch(server: any): Promise<string> {
  const response = await callTool(server, 'delegate_tasks', {
    tasks: [
      { prompt: 'Implement feature one with full test coverage', done: 'Tests pass', agentType: 'standard' as const },
      { prompt: 'Implement feature two with full test coverage', done: 'Tests pass', agentType: 'standard' as const },
    ],
  });
  return response.batchId;
}

describe('get_batch_slice tool', () => {
  it('slice=output returns { output } for a specific task', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId, slice: 'output', taskIndex: 0 });

    expect(result).toHaveProperty('output', 'output for task 0');
  });

  it('slice=output returns outputs for multiple task indices', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const r0 = await callTool(server, 'get_batch_slice', { batchId, slice: 'output', taskIndex: 0 });
    const r1 = await callTool(server, 'get_batch_slice', { batchId, slice: 'output', taskIndex: 1 });

    expect(r0.output).toBe('output for task 0');
    expect(r1.output).toBe('output for task 1');
  });

  it('slice=detail returns per-task detail with review statuses and agents', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const detail = await callTool(server, 'get_batch_slice', { batchId, slice: 'detail', taskIndex: 0 });

    expect(detail.batchId).toBe(batchId);
    expect(detail.taskIndex).toBe(0);
    expect(detail.agentType).toBe('standard');
    expect(detail.filesRead).toEqual(['src/read-0.ts', 'src/also-read-0.ts']);
    expect(detail.filesWritten).toEqual(['src/wrote-0.ts']);
    expect(detail.directoriesListed).toEqual(['src']);
    expect(detail.toolCalls).toEqual([
      'readFile src/read-0.ts',
      'grep foo → 2 hits',
      'writeFile src/wrote-0.ts',
    ]);
    expect(detail.escalationLog).toHaveLength(1);
    expect(detail.escalationLog[0].provider).toBe('mock');
    expect(detail.terminationReason?.workerSelfAssessment).toBe('done');
    expect(detail.specReviewStatus).toBe('approved');
    expect(detail.qualityReviewStatus).toBe('approved');
    expect(detail.agents).toEqual({
      normalizer: 'standard',
      implementer: 'standard',
      specReviewer: 'standard',
      qualityReviewer: 'standard',
    });
    expect(detail.implementationReport).toEqual({
      summary: 'implemented successfully',
      concerns: [],
      warnings: [],
      sections: [],
    });
    expect(detail.specReviewReport).toEqual({
      summary: 'spec approved',
      concerns: [],
      warnings: [],
      sections: [],
    });
    expect(detail.qualityReviewReport).toEqual({
      summary: 'quality approved',
      concerns: [],
      warnings: [],
      sections: [],
    });
  });

  it('slice=telemetry returns batch-wide ROI telemetry', async () => {
    const server = await makeServer();
    const dispatch = await callTool(server, 'delegate_tasks', {
      tasks: [
        { prompt: 'Implement feature one with full test coverage', done: 'Tests pass', agentType: 'standard' as const, parentModel: 'claude-opus-4-6' },
        { prompt: 'Implement feature two with full test coverage', done: 'Tests pass', agentType: 'standard' as const, parentModel: 'claude-opus-4-6' },
      ],
    });

    const telemetry = await callTool(server, 'get_batch_slice', { batchId: dispatch.batchId, slice: 'telemetry' });

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
      new RegExp(`^2 tasks, ${dispatch.batchProgress.completedTasks}/2 ok`),
    );
  });

  it('returns an error for an unknown batchId', async () => {
    const server = await makeServer();

    await expect(
      callTool(server, 'get_batch_slice', { batchId: 'nonexistent', slice: 'output', taskIndex: 0 }),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('returns an out-of-range error for a taskIndex past the batch size', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    await expect(
      callTool(server, 'get_batch_slice', { batchId, slice: 'output', taskIndex: 99 }),
    ).rejects.toThrow(/out of range/);
  });

  it('telemetry envelope is under 2 KB on a 2-task batch', async () => {
    const server = await makeServer();
    const dispatch = await callTool(server, 'delegate_tasks', {
      tasks: [
        { prompt: 'Implement feature one with full test coverage', done: 'Tests pass', agentType: 'standard' as const },
        { prompt: 'Implement feature two with full test coverage', done: 'Tests pass', agentType: 'standard' as const },
      ],
    });

    const telemetry = await callTool(server, 'get_batch_slice', { batchId: dispatch.batchId, slice: 'telemetry' });
    expect(JSON.stringify(telemetry).length).toBeLessThan(2 * 1024);
  });

  it('old get_task_output tool is NOT registered', async () => {
    const server = await makeServer();
    expect(server._registeredTools?.get_task_output).toBeUndefined();
  });

  it('old get_task_detail tool is NOT registered', async () => {
    const server = await makeServer();
    expect(server._registeredTools?.get_task_detail).toBeUndefined();
  });

  it('old get_batch_telemetry tool is NOT registered', async () => {
    const server = await makeServer();
    expect(server._registeredTools?.get_batch_telemetry).toBeUndefined();
  });
});
