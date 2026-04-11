import { describe, it, expect, vi } from 'vitest';
import { buildMcpServer } from '@zhixuan92/multi-model-agent-mcp';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', async () => {
  const actual = await vi.importActual<typeof import('@zhixuan92/multi-model-agent-core/run-tasks')>(
    '@zhixuan92/multi-model-agent-core/run-tasks',
  );
  return {
    ...actual,
    runTasks: vi.fn(async () => [] as RunResult[]),
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

describe('slim summary envelope size', () => {
  it('11-task batch with worst-case escalation chains stays under 8 KB', async () => {
    const worstCaseResults: RunResult[] = Array.from({ length: 11 }, (_, i) => ({
      output: 'x'.repeat(2000),
      status: 'incomplete',
      usage: {
        inputTokens: 50_000,
        outputTokens: 8_000,
        totalTokens: 58_000,
        costUSD: 0.12,
        savedCostUSD: 0.83,
      },
      turns: 42,
      filesRead: Array.from({ length: 40 }, (_, j) => `src/very/deeply/nested/path/to/file-${i}-${j}.ts`),
      filesWritten: Array.from({ length: 10 }, (_, j) => `src/very/deeply/nested/path/to/output-${i}-${j}.ts`),
      directoriesListed: ['src', 'tests', 'packages/core/src', 'packages/mcp/src'],
      toolCalls: Array.from(
        { length: 60 },
        (_, j) => `readFile src/very/deeply/nested/path/to/file-${i}-${j}.ts → 1823 bytes`,
      ),
      outputIsDiagnostic: false,
      escalationLog: [
        {
          provider: 'minimax',
          status: 'incomplete',
          turns: 20,
          inputTokens: 30_000,
          outputTokens: 4_000,
          costUSD: 0.02,
          initialPromptLengthChars: 1200,
          initialPromptHash: 'a'.repeat(64),
          reason: 'degenerate completion after 3 supervision retries — the worker emitted only thinking content and never produced a final answer',
        },
        {
          provider: 'codex',
          status: 'incomplete',
          turns: 15,
          inputTokens: 40_000,
          outputTokens: 5_000,
          costUSD: 0.08,
          initialPromptLengthChars: 1200,
          initialPromptHash: 'a'.repeat(64),
          reason: 'expectedCoverage contract unmet: missing markers "section-1", "section-2", "section-3"',
        },
        {
          provider: 'claude',
          status: 'incomplete',
          turns: 7,
          inputTokens: 50_000,
          outputTokens: 8_000,
          costUSD: 0.12,
          initialPromptLengthChars: 1200,
          initialPromptHash: 'a'.repeat(64),
          reason: 'timeout after 600s',
        },
      ],
      durationMs: 354_000,
      progressTrace: Array.from({ length: 20 }, (_, j) => ({
        kind: 'escalation_start' as any,
        at: Date.now(),
        taskIndex: i,
        attempt: j,
      })),
    }));

    const runTasksMod = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(runTasksMod.runTasks).mockImplementationOnce(async () => worstCaseResults);

    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegateTool = (server as any)._registeredTools['delegate_tasks'];
    const result = await delegateTool.handler(
      {
        tasks: Array.from({ length: 11 }, (_, i) => ({
          prompt: `task ${i}`,
          provider: 'mock',
          tier: 'standard',
          requiredCapabilities: [],
          parentModel: 'claude-opus-4-6',
          includeProgressTrace: true,
        })),
        responseMode: 'summary',
      },
      {},
    );

    const rawText = result.content[0].text;
    expect(rawText.length).toBeLessThan(8 * 1024);

    const payload = JSON.parse(rawText);
    expect(payload.mode).toBe('summary');
    expect(payload.results).toHaveLength(11);
    expect(payload.headline).toContain('11 tasks');

    const task0 = payload.results[0];
    expect(task0).not.toHaveProperty('filesRead');
    expect(task0).not.toHaveProperty('filesWritten');
    expect(task0).not.toHaveProperty('toolCalls');
    expect(task0).not.toHaveProperty('escalationLog');
    expect(task0).not.toHaveProperty('progressTrace');
  });
});
