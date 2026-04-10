import { vi, beforeEach, afterEach } from 'vitest';
import { stripThinkingTags } from '../../packages/core/src/runners/openai-runner.js';

// -----------------------------------------------------------------------------
// stripThinkingTags — unit-level regression tests (preserved from pre-Task 3)
// -----------------------------------------------------------------------------

describe('stripThinkingTags', () => {
  it('returns plain text unchanged', () => {
    expect(stripThinkingTags('Hello world')).toBe('Hello world');
  });

  it('removes a single think block', () => {
    const input = '<think>I should say hi</think>Hello';
    expect(stripThinkingTags(input)).toBe('Hello');
  });

  it('removes multi-line think blocks', () => {
    const input = '<think>\nLet me think step by step.\n1. First...\n2. Second...\n</think>\nFinal answer';
    expect(stripThinkingTags(input)).toBe('Final answer');
  });

  it('removes multiple think blocks', () => {
    const input = '<think>first thought</think>part one<think>second thought</think>part two';
    expect(stripThinkingTags(input)).toBe('part onepart two');
  });

  it('handles think blocks with extra whitespace after', () => {
    const input = '<think>reasoning</think>\n\n\nActual response';
    expect(stripThinkingTags(input)).toBe('Actual response');
  });

  it('is non-greedy and does not eat content between blocks', () => {
    const input = '<think>a</think>middle<think>b</think>end';
    expect(stripThinkingTags(input)).toBe('middleend');
  });

  it('is case-insensitive on the tag name', () => {
    const input = '<THINK>thinking</THINK>visible';
    expect(stripThinkingTags(input)).toBe('visible');
  });

  it('leaves unrelated angle-bracket content alone', () => {
    const input = 'Here is some <code>x + y</code> and a <think>aside</think>result';
    expect(stripThinkingTags(input)).toBe('Here is some <code>x + y</code> and a result');
  });

  it('handles empty input', () => {
    expect(stripThinkingTags('')).toBe('');
  });

  it('returns a diagnostic marker when the entire output is a single think block', () => {
    const result = stripThinkingTags('<think>only thoughts</think>');
    expect(result).toBe(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
    );
  });

  it('returns a diagnostic marker when multiple think blocks fill the entire output', () => {
    const result = stripThinkingTags('<think>first</think>\n<think>second</think>');
    expect(result).toBe(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
    );
  });
});

// -----------------------------------------------------------------------------
// runOpenAI — integration of prevention + recovery + watchdog
//
// These tests mock @openai/agents so we can observe what instructions the
// Agent is constructed with, what prompt is passed to run(), and how the
// supervision / watchdog loop dispatches follow-up calls. One test per
// integration point (self-review checklist).
// -----------------------------------------------------------------------------

// Partial mock: keep the real `tool()` helper and the real
// `MaxTurnsExceededError` class (the runner uses `instanceof` on it), but
// replace `Agent`, `run`, `OpenAIChatCompletionsModel`, and
// `setTracingDisabled` with test spies we can control and inspect.
vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
      __mockAgent: true,
      name: opts.name,
      instructions: opts.instructions,
      tools: opts.tools,
      modelSettings: opts.modelSettings,
    })),
    run: vi.fn(),
    setTracingDisabled: vi.fn(),
    OpenAIChatCompletionsModel: vi.fn().mockImplementation(() => ({ __mockModel: true })),
  };
});

const { Agent: MockAgent, run: mockRun } = vi.mocked(
  await import('@openai/agents'),
);

/** Long enough that validateCompletion considers it valid (>= 200 chars). */
const VALID_FINAL_OUTPUT =
  'This is a complete sub-agent answer that is long enough to pass the validateCompletion minimum-length heuristic without any additional structural hints because it carries more than 200 characters of plain text content.';

/**
 * Build a minimal mocked @openai/agents RunResult that the runner can
 * consume. We only populate the fields the runner touches.
 */
function makeMockRunResult(overrides: {
  finalOutput?: string;
  newItems?: Array<{ type: string; rawItem: { role: string; content: Array<{ type: string; text: string }> } }>;
  inputTokens?: number;
  outputTokens?: number;
  requests?: number;
  history?: unknown[];
}) {
  const assistantText = overrides.finalOutput ?? VALID_FINAL_OUTPUT;
  return {
    finalOutput: assistantText,
    newItems: overrides.newItems ?? [
      {
        type: 'message_output_item',
        rawItem: {
          role: 'assistant',
          content: [{ type: 'output_text', text: assistantText }],
        },
      },
    ],
    history: overrides.history ?? [],
    state: {
      usage: {
        inputTokens: overrides.inputTokens ?? 1000,
        outputTokens: overrides.outputTokens ?? 200,
        totalTokens: (overrides.inputTokens ?? 1000) + (overrides.outputTokens ?? 200),
        requests: overrides.requests ?? 3,
      },
    },
  };
}

const providerConfig = {
  type: 'openai-compatible' as const,
  model: 'test-model',
  baseUrl: 'http://localhost:9999',
  apiKey: 'test-key',
};
const defaults = { maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const };

// Minimal OpenAI client stub — the runner just passes it through to the
// OpenAIChatCompletionsModel, which is itself mocked.
const clientStub = {} as unknown as import('openai').default;

describe('runOpenAI — prevention scaffolding integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses buildSystemPrompt() output as the Agent instructions and prepends the budget hint to the user prompt', async () => {
    mockRun.mockResolvedValueOnce(makeMockRunResult({}));
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');

    await runOpenAI('original user task', {}, { client: clientStub, providerConfig, defaults });

    // Agent constructor received the prevention-layer system prompt.
    // It must contain the "final assistant message" discipline line.
    const agentCall = MockAgent.mock.calls[0][0] as { instructions: string };
    expect(agentCall.instructions).toContain('final assistant message');
    expect(agentCall.instructions).toContain('Anti-pattern');

    // The user prompt passed to run() is the original prompt with the
    // buildBudgetHint preamble prepended.
    const runCall = mockRun.mock.calls[0];
    const inputArg = runCall[1] as string;
    expect(typeof inputArg).toBe('string');
    expect(inputArg).toContain('Budget reminder');
    expect(inputArg).toContain('original user task');
    expect(inputArg.indexOf('Budget reminder')).toBeLessThan(inputArg.indexOf('original user task'));
  });

  it('populates the scratchpad from result.newItems (multi-part output_text concatenation)', async () => {
    // Force the first finalOutput to be an exploration fragment so the
    // runner re-prompts and we get TWO run() calls. On the second call we
    // inspect what is returned and verify the scratchpad latest() ends up
    // as the SECOND turn's concatenated newItems text (proving the
    // extractor walked newItems, not finalOutput).
    mockRun
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: 'Let me check',
          newItems: [
            {
              type: 'message_output_item',
              rawItem: {
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'part A ' },
                  { type: 'output_text', text: 'part B' },
                ],
              },
            },
          ],
        }),
      )
      // Supervision retry also returns a degenerate output (short fragment)
      // so the loop exhausts retries and salvages from the scratchpad.
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: 'still short',
          newItems: [
            {
              type: 'message_output_item',
              rawItem: {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'concatenated turn two' }],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: 'also short',
          newItems: [
            {
              type: 'message_output_item',
              rawItem: {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'turn three text' }],
              },
            },
          ],
        }),
      );

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    // Status should be incomplete (supervision exhausted) and output should
    // be the scratchpad's latest — i.e., the extractor-populated text from
    // the last agentRun result, NOT the finalOutput field.
    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('turn three text');
  });

  it('invokes the supervision re-prompt path when validateCompletion returns invalid', async () => {
    // First call: exploration fragment → degenerate.
    // Second call: valid long answer → clean ok return.
    mockRun
      .mockResolvedValueOnce(makeMockRunResult({ finalOutput: 'Let me check' }))
      .mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT }));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);

    // The second run() call must have been a supervision re-prompt: the
    // input should be an AgentInputItem[] (conversation continuation) whose
    // LAST item is a user message containing the re-prompt wording.
    expect(mockRun).toHaveBeenCalledTimes(2);
    const secondInput = mockRun.mock.calls[1][1] as Array<{ role: string; content: string }>;
    expect(Array.isArray(secondInput)).toBe(true);
    const lastMessage = secondInput[secondInput.length - 1];
    expect(lastMessage.role).toBe('user');
    // buildRePrompt for a 'fragment' kind quotes the wording "exploration fragment".
    expect(lastMessage.content).toContain('exploration fragment');
  });

  it('triggers the force_salvage path when input tokens cross the 95% watchdog threshold', async () => {
    // Soft limit override so 95% is easy to hit: 1000 -> force_salvage at 950.
    const pc = { ...providerConfig, inputTokenSoftLimit: 1000 };

    // First and only run() returns a degenerate output AND has inputTokens=960
    // (>= 95% of 1000). The runner should force-salvage immediately.
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({
        finalOutput: 'Let me check',
        inputTokens: 960,
        newItems: [
          {
            type: 'message_output_item',
            rawItem: {
              role: 'assistant',
              content: [{ type: 'output_text', text: 'salvageable scratchpad text' }],
            },
          },
        ],
      }),
    );

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, {
      client: clientStub,
      providerConfig: pc,
      defaults,
    });

    expect(result.status).toBe('incomplete');
    // Only one run() call — the watchdog forcibly terminates before any
    // supervision re-prompt or warning nudge fires.
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('salvageable scratchpad text');
  });

  it('validates the warning-nudge response in the same iteration and returns ok when it is valid (regression #1)', async () => {
    // Reviewer bug: the prior implementation fell into the warning
    // branch, dispatched a nudge turn, then `continue`d back to the
    // loop head — causing the watchdog to fire `warning` AGAIN
    // (because input tokens only grow) and never validating the
    // nudge response. A model that produced a perfect final answer
    // in response to the nudge had its output discarded.
    //
    // Fix: fall through to validateCompletion() in the same iteration
    // so a valid nudge response returns `ok`.
    const pc = { ...providerConfig, inputTokenSoftLimit: 1_000_000 };

    // First call: 850k input tokens (warning band: 80%-95%), degenerate
    // final output so the watchdog nudge would have been dispatched.
    // Second call: 900k input tokens (still warning band, higher than
    // first) with a VALID final output. Under the fix this must be
    // validated in the same iteration and returned as `ok`.
    mockRun
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: 'Let me check',
          inputTokens: 850_000,
        }),
      )
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: VALID_FINAL_OUTPUT,
          inputTokens: 900_000,
        }),
      );

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, {
      client: clientStub,
      providerConfig: pc,
      defaults,
    });

    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);
    // Exactly two calls: initial + one nudge. NOT three or more
    // (which is what the pre-fix behaviour produced as the nudge
    // loop kept re-firing until force_salvage).
    expect(mockRun).toHaveBeenCalledTimes(2);
    // The nudge message is the last user turn on the second call.
    const secondInput = mockRun.mock.calls[1][1] as Array<{ role: string; content: string }>;
    expect(Array.isArray(secondInput)).toBe(true);
    const lastMessage = secondInput[secondInput.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('Budget pressure');
  });

  it('gives a first-turn empty output the full supervision retry budget (regression #5)', async () => {
    // Reviewer bug: `lastDegenerateOutput` was initialised to '' and
    // `sameDegenerateOutput('', '')` is true post-Task-2 — so a first
    // turn with empty `stripped` output would trip the same-output
    // early-out and break the supervision loop BEFORE any retry.
    //
    // Fix: initialise to `null` and only compare when non-null.
    // Expected flow: empty first turn → re-prompt → valid second
    // turn → ok.
    mockRun
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: '',
          newItems: [
            {
              type: 'message_output_item',
              rawItem: {
                role: 'assistant',
                content: [{ type: 'output_text', text: '' }],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT }));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);
    // Two calls: the supervision loop must have fired a re-prompt
    // for the empty first turn instead of bailing out of the loop.
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('salvages scratchpad.latest() on an SDK error instead of returning "Sub-agent error: ..."', async () => {
    // First call succeeds with a degenerate fragment (populates scratchpad).
    // Second call (the re-prompt) throws — the runner should salvage the
    // scratchpad's latest() emission, not the bare error string.
    mockRun
      .mockResolvedValueOnce(
        makeMockRunResult({
          finalOutput: 'Let me check',
          newItems: [
            {
              type: 'message_output_item',
              rawItem: {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'some buffered findings here' }],
              },
            },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('upstream API exploded'));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    expect(result.status).toBe('error');
    expect(result.output).toBe('some buffered findings here');
    expect(result.error).toBe('upstream API exploded');
  });
});
