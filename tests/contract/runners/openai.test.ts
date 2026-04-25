import { runOpenAI } from '../../../packages/core/src/runners/openai-runner.js';
import { guardNoNetwork } from '../fixtures/mock-providers.js';
import { normalize, type JsonValue } from '../serializer/normalize.js';

const VALID_FINAL_OUTPUT =
  'This is a complete OpenAI runner contract answer that is long enough to pass the completion heuristic and therefore exercises the normalized ok RunResult shape deterministically.';

const mocks = vi.hoisted(() => ({
  agentRun: vi.fn(),
}));

vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
      __mockAgent: true,
      ...opts,
    })),
    run: mocks.agentRun,
    setTracingDisabled: vi.fn(),
    OpenAIChatCompletionsModel: vi.fn().mockImplementation(() => ({ __mockModel: true })),
  };
});

function sdkRunResult() {
  return {
    finalOutput: VALID_FINAL_OUTPUT,
    history: [],
    newItems: [
      {
        type: 'message_output_item',
        rawItem: {
          role: 'assistant',
          content: [{ type: 'output_text', text: VALID_FINAL_OUTPUT }],
        },
      },
    ],
    state: {
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        requests: 1,
      },
    },
  };
}

describe('contract: runOpenAI RunResult shape', () => {
  beforeEach(() => {
    guardNoNetwork();
    mocks.agentRun.mockReset();
  });

  it('normalizes an SDK ok response into the provider RunResult contract', async () => {
    mocks.agentRun.mockResolvedValueOnce(sdkRunResult());

    const result = await runOpenAI(
      'Return a concise final answer.',
      { tools: 'none', timeoutMs: 60_000 },
      {
        client: {} as never,
        providerConfig: {
          type: 'openai-compatible',
          model: 'contract-openai-model',
          baseUrl: 'http://mock.local',
          apiKey: 'mock-key',
          inputCostPerMTok: 1,
          outputCostPerMTok: 2,
        },
        defaults: { timeoutMs: 60_000, tools: 'none' },
      },
    );

    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
    expect(normalize(result as unknown as JsonValue)).toEqual({
      output: VALID_FINAL_OUTPUT,
      status: 'ok',
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        costUSD: 0.000055,
        savedCostUSD: null,
      },
      turns: 1,
      filesRead: [],
      directoriesListed: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      durationMs: '<DETERMINISTIC>',
    });
  });
});
