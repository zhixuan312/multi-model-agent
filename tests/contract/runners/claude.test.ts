import { runClaude } from '../../../packages/core/src/runners/claude-runner.js';
import { guardNoNetwork } from '../fixtures/mock-providers.js';
import { normalize, type JsonValue } from '../serializer/normalize.js';

const VALID_FINAL_OUTPUT =
  'This is a complete Claude runner contract answer that is long enough to pass the completion heuristic and therefore exercises the normalized ok RunResult shape deterministically.';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: mocks.query,
  };
});

function assistantMsg(text: string) {
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    },
    parent_tool_use_id: null,
  };
}

function resultMsg(text: string) {
  return {
    type: 'result' as const,
    result: text,
    modelUsage: {
      'contract-claude-model': {
        inputTokens: 13,
        outputTokens: 21,
      },
    },
  };
}

describe('contract: runClaude RunResult shape', () => {
  beforeEach(() => {
    guardNoNetwork();
    mocks.query.mockReset();
  });

  it('normalizes an SDK ok response into the provider RunResult contract', async () => {
    mocks.query.mockReturnValueOnce((async function* () {
      yield assistantMsg(VALID_FINAL_OUTPUT);
      yield resultMsg(VALID_FINAL_OUTPUT);
    })());

    const result = await runClaude(
      'Return a concise final answer.',
      { tools: 'none', timeoutMs: 60_000 },
      {
        type: 'claude',
        model: 'contract-claude-model',
        inputCostPerMTok: 1,
        outputCostPerMTok: 2,
      },
      { timeoutMs: 60_000, tools: 'none' },
    );

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(normalize(result as unknown as JsonValue)).toEqual({
      output: VALID_FINAL_OUTPUT,
      status: 'ok',
      usage: {
        inputTokens: 13,
        outputTokens: 21,
        totalTokens: 34,
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
