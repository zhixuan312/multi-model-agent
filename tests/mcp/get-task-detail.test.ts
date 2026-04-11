import { describe, it, expect, vi } from 'vitest';
import { buildMcpServer } from '@zhixuan92/multi-model-agent-mcp';
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
  providers: {
    mock: {
      type: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

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
      { prompt: 't1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
      { prompt: 't2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
    ],
  });
  return response.batchId;
}

describe('get_task_detail tool', () => {
  it('returns toolCalls, filesRead/Written/Listed, escalationLog for a valid task index', async () => {
    const server = buildMcpServer(sampleConfig());
    const batchId = await dispatchFixtureBatch(server);

    const detail = await callTool(server, 'get_task_detail', { batchId, taskIndex: 0 });

    expect(detail.batchId).toBe(batchId);
    expect(detail.taskIndex).toBe(0);
    expect(detail.provider).toBe('mock');
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
});
