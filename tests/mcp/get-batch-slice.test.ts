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
          specReviewReason: undefined,
          qualityReviewReason: undefined,
          agents: {
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
  const { createDiagnosticLogger } = await import('../../packages/core/src/diagnostics/disconnect-log.js');
  return buildMcpServer(sampleConfig(), createDiagnosticLogger(), { _testRunTasksOverride: mockedRunTasks });
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
  it('returns full results for all tasks when taskIndex omitted', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId });

    expect(result.batchId).toBe(batchId);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].output).toBe('output for task 0');
    expect(result.results[1].output).toBe('output for task 1');
    expect(result).toHaveProperty('timings');
    expect(result).toHaveProperty('batchProgress');
    expect(result).toHaveProperty('aggregateCost');
  });

  it('returns filtered result for a specific taskIndex', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId, taskIndex: 0 });

    expect(result.batchId).toBe(batchId);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].output).toBe('output for task 0');
  });

  it('returns results with review statuses and agents', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId, taskIndex: 0 });
    const task = result.results[0];

    expect(task.filesRead).toEqual(['src/read-0.ts', 'src/also-read-0.ts']);
    expect(task.filesWritten).toEqual(['src/wrote-0.ts']);
    expect(task.escalationLog).toHaveLength(1);
    expect(task.specReviewStatus).toBe('approved');
    expect(task.qualityReviewStatus).toBe('approved');
  });

  it('includes specReviewReason and qualityReviewReason when present', async () => {
    const overridden = vi.fn(async (tasks: { prompt: string }[]) =>
      tasks.map(() => ({
        output: 'output',
        status: 'ok' as const,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
        turns: 1,
        filesRead: [],
        filesWritten: ['src/a.ts'],
        directoriesListed: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 500,
        specReviewStatus: 'error' as const,
        specReviewReason: 'review agent threw: connection refused',
        qualityReviewStatus: 'skipped' as const,
        qualityReviewReason: 'no files written by implementer',
        agents: {
          implementer: 'standard' as const,
          specReviewer: 'standard' as const,
          qualityReviewer: 'skipped' as const,
        },
      })),
    );

    const { buildMcpServer } = await import('../../packages/mcp/src/cli.js');
    const { createDiagnosticLogger } = await import('../../packages/core/src/diagnostics/disconnect-log.js');
    const server = buildMcpServer(sampleConfig(), createDiagnosticLogger(), { _testRunTasksOverride: overridden });

    const response = await callTool(server, 'delegate_tasks', {
      tasks: [{ prompt: 'Do the thing', done: 'Done', agentType: 'standard' as const }],
    });

    const result = await callTool(server, 'get_batch_slice', { batchId: response.batchId, taskIndex: 0 });

    expect(result.results[0].specReviewReason).toBe('review agent threw: connection refused');
    expect(result.results[0].qualityReviewReason).toBe('no files written by implementer');
  });

  it('returns telemetry fields (timings, batchProgress, aggregateCost)', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId });

    expect(result).toHaveProperty('batchId', batchId);
    expect(result).toHaveProperty('timings');
    expect(result).toHaveProperty('batchProgress');
    expect(result).toHaveProperty('aggregateCost');
    expect(result.results).toHaveLength(2);

    expect(typeof result.timings.wallClockMs).toBe('number');
    expect(result.timings.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(result.batchProgress.totalTasks).toBe(2);
    expect(result.batchProgress.completedTasks).toBe(2);
  });

  it('returns error text for an unknown batchId', async () => {
    const server = await makeServer();

    const result = await callTool(server, 'get_batch_slice', { batchId: 'nonexistent' });

    expect(typeof result).toBe('string');
    expect(result).toContain('unknown or expired');
  });

  it('returns error text for an out-of-range taskIndex', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const result = await callTool(server, 'get_batch_slice', { batchId, taskIndex: 99 });

    expect(typeof result).toBe('string');
    expect(result).toContain('out of range');
  });

  it('telemetry envelope is under 2 KB on a 2-task batch', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    // get_batch_slice returns full results — just check the overhead is reasonable
    const tool = server._registeredTools?.['get_batch_slice'];
    const rawResult = await tool.handler({ batchId }, {});
    const rawText = rawResult.content[0].text;
    const parsed = JSON.parse(rawText);
    // Remove results to measure just the telemetry envelope overhead
    delete parsed.results;
    expect(JSON.stringify(parsed).length).toBeLessThan(2 * 1024);
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
