import { runCodex } from '../../../packages/core/src/runners/codex-runner.js';
import { guardNoNetwork } from '../fixtures/mock-providers.js';
import { normalize, type JsonValue } from '../serializer/normalize.js';

const VALID_FINAL_OUTPUT =
  'This is a complete Codex runner contract answer that is long enough to pass the completion heuristic and therefore exercises the normalized ok RunResult shape deterministically.';

const mocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  getCodexAuth: vi.fn(),
}));

vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    responses: { create: mocks.responsesCreate },
  }));
  return { default: MockOpenAI };
});

vi.mock('../../../packages/core/src/auth/codex-oauth.js', () => ({
  getCodexAuth: mocks.getCodexAuth,
}));

describe('contract: runCodex RunResult shape', () => {
  beforeEach(() => {
    guardNoNetwork();
    mocks.responsesCreate.mockReset();
    mocks.getCodexAuth.mockReset();
    mocks.getCodexAuth.mockReturnValue({ accessToken: 'mock-token', accountId: 'mock-account' });
  });

  it('normalizes an SDK ok response into the provider RunResult contract', async () => {
    mocks.responsesCreate.mockReturnValueOnce((async function* () {
      yield { type: 'response.output_text.delta', delta: VALID_FINAL_OUTPUT };
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 17, output_tokens: 19 },
        },
      };
    })());

    const result = await runCodex(
      'Return a concise final answer.',
      { tools: 'none', timeoutMs: 60_000 },
      {
        type: 'codex',
        model: 'contract-codex-model',
        hostedTools: [],
        inputCostPerMTok: 1,
        outputCostPerMTok: 2,
      },
      { timeoutMs: 60_000, tools: 'none' },
    );

    expect(mocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(normalize(result as unknown as JsonValue)).toEqual({
      output: VALID_FINAL_OUTPUT,
      status: 'ok',
      usage: {
        inputTokens: 17,
        outputTokens: 19,
        totalTokens: 36,
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
