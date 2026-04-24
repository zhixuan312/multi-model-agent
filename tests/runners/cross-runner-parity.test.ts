import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InternalRunnerEvent } from '../../packages/core/src/runners/types.js';

// -----------------------------------------------------------------------------
// Cross-runner progress-event parity (Task 11)
// -----------------------------------------------------------------------------
//
// This test runs the same happy-path scenario through all three runners
// (openai / claude / codex) and asserts the `ProgressEvent.kind` sequence
// is consistent. This is the structural guarantee that streaming is
// "consistent regardless of which provider backs the dispatch" from the
// spec success criteria.
//
// Scenario: one assistant turn, one text emission of VALID_FINAL_OUTPUT
// (>= 10 chars so validateCompletion auto-accepts it by length),
// termination as status='ok'. No tool calls, no supervision retries, no
// watchdog trips. This is the minimum viable "end-to-end one-turn run".
//
// Why this scope: the three SDKs are fundamentally different (openai's
// @openai/agents returns a single result object with cumulative usage;
// claude's claude-agent-sdk emits a stream of `assistant` + `result`
// messages; codex's Responses API streams events with a hand-rolled loop).
// A one-turn happy-path is the scenario where all three converge on
// identical ProgressEvent ordering. Multi-turn / tool-call scenarios
// diverge per-SDK (e.g. claude fires tool_call BEFORE its `assistant`
// message arrives in the stream because MCP tool calls happen inside the
// SDK loop) and would force a relaxed assertion. The one-turn happy-path
// is the load-bearing parity contract — if the runners produce the same
// sequence here, observers can rely on the same mental model regardless
// of provider.
//
// If this test fails, it means one of the runners is emitting events in a
// different order — fix the RUNNER, not the test.
// -----------------------------------------------------------------------------

/** Shared ≥10-char text that passes the validateCompletion minimum-length heuristic. */
const VALID_FINAL_OUTPUT =
  'This is a complete sub-agent answer that passes the validateCompletion minimum-length heuristic.';

// ---- openai mocks -----------------------------------------------------------

vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
      __mockAgent: true,
      name: opts.name,
      instructions: opts.instructions,
      tools: opts.tools,
    })),
    run: vi.fn(),
    setTracingDisabled: vi.fn(),
    OpenAIChatCompletionsModel: vi.fn().mockImplementation(() => ({ __mockModel: true })),
  };
});

const { run: mockOpenAIRun } = vi.mocked(await import('@openai/agents'));

function makeOpenAIRunResult(text: string) {
  return {
    finalOutput: text,
    newItems: [
      {
        type: 'message_output_item',
        rawItem: {
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      },
    ],
    history: [],
    state: {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        requests: 1,
      },
    },
  };
}

// ---- claude mocks -----------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: vi.fn(),
  };
});

const { query: mockClaudeQuery } = vi.mocked(
  await import('@anthropic-ai/claude-agent-sdk'),
);

function claudeAssistantMsg(text: string) {
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    },
    parent_tool_use_id: null,
  };
}

function claudeResultMsg(text: string) {
  return {
    type: 'result' as const,
    result: text,
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 100,
        outputTokens: 50,
      },
    },
  };
}

// ---- codex mocks ------------------------------------------------------------

const mockCodexResponsesCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    responses: { create: mockCodexResponsesCreate },
  }));
  return { default: MockOpenAI };
});

vi.mock('../../packages/core/src/auth/codex-oauth.js', () => ({
  getCodexAuth: vi.fn(),
}));

// =============================================================================

describe('cross-runner parity — progress event sequence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  interface ScenarioResult {
    runner: 'openai' | 'claude' | 'codex';
    eventKinds: string[];
    status: string;
  }

  async function runOpenAIScenario(): Promise<ScenarioResult> {
    mockOpenAIRun.mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeOpenAIRunResult(VALID_FINAL_OUTPUT) as any,
    );
    const events: ProgressEvent[] = [];
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const clientStub = {} as unknown as import('openai').default;
    const result = await runOpenAI(
      'prompt',
      { onProgress: (e) => events.push(e) },
      {
        client: clientStub,
        providerConfig: {
          type: 'openai-compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:9999',
          apiKey: 'test-key',
        },
        defaults: { timeoutMs: 600_000, tools: 'full' },
      },
    );
    return { runner: 'openai', eventKinds: events.map((e) => e.kind), status: result.status };
  }

  async function runClaudeScenario(): Promise<ScenarioResult> {
    (mockClaudeQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      (async function* () {
        yield claudeAssistantMsg(VALID_FINAL_OUTPUT);
        yield claudeResultMsg(VALID_FINAL_OUTPUT);
      })(),
    );
    const events: ProgressEvent[] = [];
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const result = await runClaude(
      'prompt',
      { onProgress: (e) => events.push(e) },
      { type: 'claude', model: 'claude-sonnet-4-6' },
      { timeoutMs: 600_000, tools: 'full' },
    );
    return { runner: 'claude', eventKinds: events.map((e) => e.kind), status: result.status };
  }

  async function runCodexScenario(): Promise<ScenarioResult> {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    mockCodexResponsesCreate.mockImplementationOnce(() => {
      return (async function* () {
        yield { type: 'response.output_text.delta', delta: VALID_FINAL_OUTPUT };
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 50 } },
        };
      })();
    });
    const events: ProgressEvent[] = [];
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      { onProgress: (e) => events.push(e) },
      { type: 'codex', model: 'gpt-5-codex' },
      { timeoutMs: 600_000, tools: 'full' },
    );
    return { runner: 'codex', eventKinds: events.map((e) => e.kind), status: result.status };
  }

  it('all three runners emit the same kind sequence for a one-turn ok scenario', async () => {
    const openai = await runOpenAIScenario();
    const claude = await runClaudeScenario();
    const codex = await runCodexScenario();

    // Sanity: every runner reached the ok happy path. If any of these
    // tripped up (e.g. validateCompletion rejected VALID_FINAL_OUTPUT and
    // the supervision loop inserted extra turns), the sequence comparison
    // below would be meaningless.
    expect(openai.status).toBe('ok');
    expect(claude.status).toBe('ok');
    expect(codex.status).toBe('ok');

    // The load-bearing parity contract: for a one-turn happy-path, every
    // runner emits exactly this sequence. Any drift means one runner
    // changed its emission points — fix the runner, not the test.
    const expected = ['turn_start', 'text_emission', 'turn_complete', 'done'];
    expect(openai.eventKinds).toEqual(expected);
    expect(claude.eventKinds).toEqual(expected);
    expect(codex.eventKinds).toEqual(expected);

    // Transitive equality (belt + braces — makes the parity assertion
    // explicit in test output even if `expected` above is ever relaxed).
    expect(openai.eventKinds).toEqual(claude.eventKinds);
    expect(claude.eventKinds).toEqual(codex.eventKinds);
  });

  it('every runner terminates with exactly one done event as the last event', async () => {
    const scenarios: ScenarioResult[] = [
      await runOpenAIScenario(),
      await runClaudeScenario(),
      await runCodexScenario(),
    ];
    for (const s of scenarios) {
      const doneCount = s.eventKinds.filter((k) => k === 'done').length;
      expect(doneCount, `${s.runner} should emit exactly one done`).toBe(1);
      expect(s.eventKinds[s.eventKinds.length - 1], `${s.runner} should end with done`).toBe('done');
      expect(s.eventKinds[0], `${s.runner} should start with turn_start`).toBe('turn_start');
    }
  });
});
