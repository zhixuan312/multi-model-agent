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
        })),
    ),
  };
});

const sampleConfig = (): MultiModelConfig => ({
  agents: {
    standard: { type: 'openai-compatible', model: 'test-model', baseUrl: 'http://localhost:1234/v1' },
    complex: { type: 'openai-compatible', model: 'test-model-complex', baseUrl: 'http://localhost:1235/v1' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
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
      { prompt: 't1', agentType: 'standard' as const },
      { prompt: 't2', agentType: 'standard' as const },
    ],
  });
  return response.batchId;
}

describe('get_task_detail tool', () => {
  it('returns toolCalls, filesRead/Written/Listed, escalationLog for a valid task index', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const detail = await callTool(server, 'get_task_detail', { batchId, taskIndex: 0 });

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
    expect(detail.escalationLog[0].initialPromptHash).toBe('abc');

    expect(detail).not.toHaveProperty('output');
    expect(detail).not.toHaveProperty('status');
    expect(detail).not.toHaveProperty('usage');
    expect(detail).not.toHaveProperty('turns');
    expect(detail).not.toHaveProperty('durationMs');
    expect(detail).not.toHaveProperty('error');
  });

  it('returns an error for an unknown batchId', async () => {
    const server = await makeServer();

    await expect(
      callTool(server, 'get_task_detail', { batchId: 'nonexistent', taskIndex: 0 }),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('returns an out-of-range error for a taskIndex past the batch size', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    await expect(
      callTool(server, 'get_task_detail', { batchId, taskIndex: 99 }),
    ).rejects.toThrow(/out of range/);
  });

  it('omits progressTrace when the task was not dispatched with includeProgressTrace', async () => {
    const server = await makeServer();
    const batchId = await dispatchFixtureBatch(server);

    const detail = await callTool(server, 'get_task_detail', { batchId, taskIndex: 0 });
    expect(detail).not.toHaveProperty('progressTrace');
  });

  it('includes progressTrace when the RunResult has one', async () => {
    const runTasksMod = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(runTasksMod.runTasks).mockImplementationOnce(async () => [
      {
        output: 'ok',
        status: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
        progressTrace: [
          { kind: 'escalation_start', at: 1000, taskIndex: 0, attempt: 0 } as any,
        ],
        durationMs: 100,
      } as RunResult,
    ]);

    const server = await makeServer();
    const response = await callTool(server, 'delegate_tasks', {
      tasks: [
        {
          prompt: 'traced',
          agentType: 'standard' as const,
          includeProgressTrace: true,
        },
      ],
    });
    const detail = await callTool(server, 'get_task_detail', { batchId: response.batchId, taskIndex: 0 });

    expect(detail).toHaveProperty('progressTrace');
    expect(detail.progressTrace).toHaveLength(1);
    expect(detail.progressTrace[0]).toMatchObject({
      kind: 'escalation_start',
      taskIndex: 0,
      attempt: 0,
    });
  });
});
