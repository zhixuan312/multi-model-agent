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
    mockRun.mockReset();
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
    expect(agentCall.instructions).toContain('Tool rules:');

    // The user prompt passed to run() is the original prompt with the
    // buildBudgetHint preamble prepended.
    const runCall = mockRun.mock.calls[0];
    const inputArg = runCall[1] as string;
    expect(typeof inputArg).toBe('string');
    expect(inputArg).toContain('Budget:');
    expect(inputArg).toContain('original user task');
    expect(inputArg.indexOf('Budget:')).toBeLessThan(inputArg.indexOf('original user task'));
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

  // ---------------------------------------------------------------------------
  // Task 9: progress event emission contract
  //
  // These tests pin the sequence of `ProgressEvent`s that openai-runner emits
  // across the supervision loop for the scenarios that matter in practice:
  //   - happy path        → turn_start → text_emission → turn_complete → done(ok)
  //   - supervise_fragment → injection event on the re-prompt
  //   - tool_call          → tracker callback routes through onProgress
  // ---------------------------------------------------------------------------

  it('emits turn_start → text_emission → turn_complete → done(ok) on the happy path (Task 9)', async () => {
    mockRun.mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT, requests: 1 }));
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');

    const result = await runOpenAI(
      'task',
      { onProgress: (e) => events.push(e) },
      { client: clientStub, providerConfig, defaults },
    );

    expect(result.status).toBe('ok');

    // Filter out tool_call / injection events (none expected here) so the
    // sequence assertion is stable even if an unrelated event ever sneaks in.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['turn_start', 'text_emission', 'turn_complete', 'done']);

    const turnStart = events[0] as { kind: 'turn_start'; turn: number; provider: string };
    expect(turnStart.turn).toBe(1); // first turn = (undefined?.requests ?? 0) + 1
    expect(turnStart.provider).toBe('openai-compatible');

    const textEmission = events[1] as { kind: 'text_emission'; turn: number; chars: number; preview: string };
    expect(textEmission.turn).toBe(1); // post-call requests count from mockRunResult
    expect(textEmission.chars).toBe(VALID_FINAL_OUTPUT.length);
    expect(textEmission.preview.length).toBeLessThanOrEqual(200);
    expect(VALID_FINAL_OUTPUT.startsWith(textEmission.preview)).toBe(true);

    const turnComplete = events[2] as {
      kind: 'turn_complete';
      turn: number;
      cumulativeInputTokens: number;
      cumulativeOutputTokens: number;
    };
    expect(turnComplete.turn).toBe(1);
    expect(turnComplete.cumulativeInputTokens).toBe(1000);
    expect(turnComplete.cumulativeOutputTokens).toBe(200);

    const done = events[3] as { kind: 'done'; status: string };
    expect(done.status).toBe('ok');
  });

  it('emits an injection event with supervise_fragment when validation fails on a short fragment (Task 9)', async () => {
    // First call: an exploration fragment → supervision re-prompt.
    // Second call: a valid answer → clean ok return.
    mockRun
      .mockResolvedValueOnce(makeMockRunResult({ finalOutput: 'Let me check', requests: 1 }))
      .mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT, requests: 2 }));

    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    await runOpenAI(
      'task',
      { onProgress: (e) => events.push(e) },
      { client: clientStub, providerConfig, defaults },
    );

    const injection = events.find((e) => e.kind === 'injection') as
      | { kind: 'injection'; injectionType: string; turn: number; contentLengthChars: number }
      | undefined;
    expect(injection).toBeDefined();
    expect(injection!.injectionType).toBe('supervise_fragment');
    expect(injection!.turn).toBe(1); // pre-retry turn == first turn's requests
    expect(injection!.contentLengthChars).toBeGreaterThan(0);

    // The injection event precedes the next turn_start, establishing the
    // "inject, then dispatch" ordering observers rely on.
    const injectionIdx = events.indexOf(injection!);
    const nextTurnStartIdx = events.findIndex(
      (e, i) => i > injectionIdx && e.kind === 'turn_start',
    );
    expect(nextTurnStartIdx).toBeGreaterThan(injectionIdx);
  });

  it('emits a tool_call event when the tracker records a tool invocation (Task 9)', async () => {
    // Have the mocked run() reach into the Agent's wired tools and invoke
    // the `glob` tool directly — this routes through the real
    // ToolImplementations.glob, which calls tracker.trackToolCall(), which
    // (via the Task 9 tracker callback) emits a tool_call ProgressEvent.
    const { RunContext } = await import('@openai/agents');
    mockRun.mockImplementationOnce(async (agent, _input, _opts) => {
      // `agent` here is the object our MockAgent constructor returns.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentAny = agent as any;
      const tools = agentAny.tools as Array<{ name: string; invoke: Function }>;
      const globTool = tools.find((t) => t.name === 'glob');
      if (globTool) {
        await globTool.invoke(new RunContext(), JSON.stringify({ pattern: '*.nope' }));
      }
      return makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT, requests: 1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI(
      'task',
      { onProgress: (e) => events.push(e) },
      { client: clientStub, providerConfig, defaults },
    );

    expect(result.status).toBe('ok');
    const toolCall = events.find((e) => e.kind === 'tool_call') as
      | { kind: 'tool_call'; turn: number; toolSummary: string }
      | undefined;
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolSummary).toContain('glob(*.nope)');
    // Tool call fired DURING the first turn, before agentRun returned, so
    // it is attributed to turn 1 (the in-flight turn).
    expect(toolCall!.turn).toBe(1);

    // And it sits between turn_start and turn_complete of turn 1.
    const kinds = events.map((e) => e.kind);
    const ts = kinds.indexOf('turn_start');
    const tc = kinds.indexOf('turn_complete');
    const tk = kinds.indexOf('tool_call');
    expect(ts).toBeLessThan(tk);
    expect(tk).toBeLessThan(tc);
  });

  it('salvages scratchpad.latest() on an SDK error instead of returning "Sub-agent error: ..."', async () => {
    // First call succeeds with a degenerate fragment (populates scratchpad).
    // Second call (the re-prompt) throws — the runner should salvage the
    // scratchpad's latest() emission, not the bare error string.
    mockRun
      .mockImplementationOnce(async (agent) => {
        const { RunContext } = await import('@openai/agents');
        const agentAny = agent as any;
        const tools = agentAny.tools as Array<{ name: string; invoke: Function }>;
        const listFilesTool = tools.find((t) => t.name === 'list_files');
        if (listFilesTool) {
          await listFilesTool.invoke(new RunContext(), JSON.stringify({ path: '.' }));
        }
        return makeMockRunResult({
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
        });
      })
      .mockRejectedValueOnce(new Error('upstream API exploded'));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    expect(result.status).toBe('error');
    expect(result.output).toBe('some buffered findings here');
    expect(result.error).toBe('upstream API exploded');
    expect(result.directoriesListed).toEqual([process.cwd()]);
  });

  // Task 5 + 8: coverage validation integration + continuation budget regression
  it('coverage validation: task without expectedCoverage skips validateCoverage', async () => {
    mockRun.mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT }));
    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');

    // A task without expectedCoverage gets ok without needing coverage checks
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });
    expect(result.status).toBe('ok');
  });

  it('coverage validation: insufficient_coverage triggers re-prompt and retries', async () => {
    // First run: short output that passes completion heuristic but lacks required markers
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({ finalOutput: 'Mentions section alpha only.' }),
    );
    // Second run (re-prompt): now includes all required markers
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({ finalOutput: 'Here are 1.1, 1.2, and 1.3 covered in detail.' }),
    );

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI(
      'Audit items 1.1, 1.2, 1.3',
      {
        expectedCoverage: {
          requiredMarkers: ['1.1', '1.2', '1.3'],
        },
      },
      { client: clientStub, providerConfig, defaults },
    );

    // Runner should have re-prompted once and then succeeded
    expect(result.status).toBe('ok');
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('1.1');
  });

  it('coverage validation: insufficient_coverage exhausts retries → incomplete or error', async () => {
    // All 3 calls return valid-length text but WITHOUT required markers.
    // Mock exhausted on 4th call → runner falls to error path.
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({ finalOutput: 'Only item alpha is covered here.' }),
    );
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({ finalOutput: 'Still only item alpha, nothing about beta.' }),
    );
    mockRun.mockRejectedValueOnce(new Error('mock exhausted'));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI(
      'Audit items 1.1, 1.2, 1.3',
      {
        expectedCoverage: {
          requiredMarkers: ['1.1', '1.2', '1.3'],
        },
      },
      { client: clientStub, providerConfig, defaults },
    );

    // After 3 retries with no coverage recovery, runner exhausts retries
    // and falls through to the outer error handler (when 4th mock call throws).
    expect(['incomplete', 'error']).toContain(result.status);
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it('continuation budget: re-prompt continuation does not throw MaxTurnsExceededError with budget=5', async () => {
    // First call: degenerate fragment → supervision re-prompts with budget=5
    mockRun.mockResolvedValueOnce(
      makeMockRunResult({
        finalOutput: 'Fragment',
        requests: 4,
        outputTokens: 50,
      }),
    );
    // Re-prompt continuation: the model needs a tool call and replies to it.
    // With budget=1 this would exhaust and throw. With budget=5 it completes.
    mockRun.mockResolvedValueOnce(makeMockRunResult({ finalOutput: VALID_FINAL_OUTPUT, requests: 5 }));

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');
    const result = await runOpenAI('task', {}, { client: clientStub, providerConfig, defaults });

    // With SUPERVISION_CONTINUATION_BUDGET=5, the re-prompt continuation
    // gets enough budget to complete, not throw, and we get ok
    expect(result.status).toBe('ok');
    expect(mockRun).toHaveBeenCalledTimes(2); // initial + 1 continuation
  });
});
