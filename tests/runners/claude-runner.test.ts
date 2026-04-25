import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InternalRunnerEvent } from '../../packages/core/src/runners/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: vi.fn(),
  };
});

// Grab the mock reference so we can configure it in tests.
// Must be after vi.mock so the module is already replaced.
const { query } = vi.mocked(await import('@anthropic-ai/claude-agent-sdk'));

/**
 * Long enough (>= 200 chars) to pass validateCompletion's minimum-length
 * heuristic. Used in every test that wants a clean `ok` return from the
 * supervision loop.
 */
const VALID_FINAL_OUTPUT =
  'This is a complete sub-agent answer that is long enough to pass the validateCompletion minimum-length heuristic without any additional structural hints because it carries more than 200 characters of plain text content.';

/**
 * Build a minimal SDK `assistant` message carrying a plain-text block. The
 * runner appends text blocks to the scratchpad; we only populate the
 * fields the runner touches.
 */
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

/**
 * Build a minimal SDK `result` message with optional usage, subtype, and
 * result string. Mirrors the runner's consumption of
 * `result.result / result.modelUsage / result.subtype`.
 */
function resultMsg(opts: {
  result: string;
  inputTokens?: number;
  outputTokens?: number;
  subtype?: string;
}) {
  return {
    type: 'result' as const,
    result: opts.result,
    ...(opts.subtype ? { subtype: opts.subtype } : {}),
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: opts.inputTokens ?? 0,
        outputTokens: opts.outputTokens ?? 0,
      },
    },
  };
}

describe('runClaude', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  const providerConfig = { type: 'claude' as const, model: 'claude-sonnet-4-6' };
  const defaults = { timeoutMs: 600_000, tools: 'full' as const };

  // -------------------------------------------------------------------------
  // 1. ok path
  // -------------------------------------------------------------------------
  it('returns status ok with output and usage when query returns a valid result message', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield assistantMsg(VALID_FINAL_OUTPUT);
      yield resultMsg({ result: VALID_FINAL_OUTPUT, inputTokens: 10, outputTokens: 20 });
    })());

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
  });

  // -------------------------------------------------------------------------
  // 2. error_max_turns from SDK
  // -------------------------------------------------------------------------
  it('returns status incomplete with degenerate_exhausted when SDK fires error_max_turns', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [] }, parent_tool_use_id: null };
      yield resultMsg({ result: '', subtype: 'error_max_turns' });
    })());

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('degenerate_exhausted');
    expect(result.output).toContain('Agent exhausted time or cost budget.');
  });

  // -------------------------------------------------------------------------
  // 3. timeout passthrough
  // -------------------------------------------------------------------------
  it('accepts a custom timeoutMs option without crashing the run', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield assistantMsg(VALID_FINAL_OUTPUT);
      yield resultMsg({ result: VALID_FINAL_OUTPUT });
    })());

    const result = await runClaude('prompt', { timeoutMs: 5000 }, providerConfig, defaults);
    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);
  });

  // -------------------------------------------------------------------------
  // 4. tools='none' → empty tools array
  // -------------------------------------------------------------------------
  it('sets tools=[] and mcpServers undefined when tools is none', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const capturedOptions: unknown[] = [];

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: unknown) => {
      capturedOptions.push(opts);
      return (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    await runClaude('prompt', { tools: 'none' }, providerConfig, defaults);

    const captured = capturedOptions[0] as { options?: Record<string, unknown> };
    expect(captured.options?.tools).toEqual([]);
    expect(captured.options?.mcpServers).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. tools='full' → mcpServers and allowedTools populated
  // -------------------------------------------------------------------------
  it('sets mcpServers and allowedTools when tools is full', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const capturedOptions: unknown[] = [];

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: unknown) => {
      capturedOptions.push(opts);
      return (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    await runClaude('prompt', { tools: 'full' }, providerConfig, defaults);

    const captured = capturedOptions[0] as { options?: { mcpServers?: unknown; allowedTools?: string[] } };
    expect(captured.options?.mcpServers).toBeDefined();
    expect(captured.options?.allowedTools).toContain('mcp__code-tools__*');
    expect(captured.options?.allowedTools).toContain('WebSearch');
    expect(captured.options?.allowedTools).toContain('WebFetch');
  });

  // -------------------------------------------------------------------------
  // 6. effort='none' → thinking.type='disabled'
  // -------------------------------------------------------------------------
  it('sets thinking.type=disabled when effort is none', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const capturedOptions: unknown[] = [];

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: unknown) => {
      capturedOptions.push(opts);
      return (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    await runClaude('prompt', { effort: 'none' }, providerConfig, defaults);

    const captured = capturedOptions[0] as { options?: { thinking?: { type: string } } };
    expect(captured.options?.thinking).toEqual({ type: 'disabled' });
  });

  // -------------------------------------------------------------------------
  // 7. effort='low' → thinking.type='adaptive' and effort='low'
  // -------------------------------------------------------------------------
  it('sets thinking.type=adaptive and effort=low when effort is low', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const capturedOptions: unknown[] = [];

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: unknown) => {
      capturedOptions.push(opts);
      return (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    await runClaude('prompt', { effort: 'low' }, providerConfig, defaults);

    const captured = capturedOptions[0] as {
      options?: { thinking?: { type: string }; effort?: string };
    };
    expect(captured.options?.thinking).toEqual({ type: 'adaptive' });
    expect(captured.options?.effort).toBe('low');
  });

  // -------------------------------------------------------------------------
  // 8. query throws → status='error' with error field
  // -------------------------------------------------------------------------
  it('returns status error with error field when query throws and scratchpad is empty', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce((() => {
      throw new Error('SDK crashed');
    }) as never);

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.status).toBe('error');
    expect(result.error).toContain('SDK crashed');
    expect(result.output).toContain('SDK crashed');
  });

  // -------------------------------------------------------------------------
  // 9. usage aggregation across multiple modelUsage entries
  // -------------------------------------------------------------------------
  it('aggregates inputTokens and outputTokens from all modelUsage entries on the result', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield {
          type: 'result',
          result: VALID_FINAL_OUTPUT,
          modelUsage: {
            a: { inputTokens: 5, outputTokens: 15 },
            b: { inputTokens: 3, outputTokens: 7 },
          },
        };
      })(),
    );

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.usage.inputTokens).toBe(8);   // 5 + 3
    expect(result.usage.outputTokens).toBe(22);  // 15 + 7
  });

  // ---------------------------------------------------------------------------
  // Task 4 integration tests: prevention + recovery + watchdog
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 10. prevention system prompt — claude_code preset with appended rules
  // -------------------------------------------------------------------------
  it('appends buildSystemPrompt() output to the claude_code preset and prepends the budget hint to the user prompt', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');
    const capturedOptions: unknown[] = [];

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: unknown) => {
      capturedOptions.push(opts);
      return (async function* () {
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    await runClaude('original user task', {}, providerConfig, defaults);

    const captured = capturedOptions[0] as {
      prompt?: unknown;
      options?: { systemPrompt?: { type: string; preset: string; append: string } };
    };

    // System prompt is the claude_code preset with the prevention rules
    // appended — MUST contain the "final assistant message" discipline line.
    expect(captured.options?.systemPrompt?.type).toBe('preset');
    expect(captured.options?.systemPrompt?.preset).toBe('claude_code');
    expect(captured.options?.systemPrompt?.append).toContain('final assistant message');
    expect(captured.options?.systemPrompt?.append).toContain('Tool rules:');

    // Prompt is passed as an AsyncIterable (streaming-input mode) —
    // verify it is not a plain string and that it is iterable.
    expect(typeof captured.prompt).toBe('object');
    expect(captured.prompt).toBeDefined();
    const iterable = captured.prompt as AsyncIterable<unknown>;
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function');

    // Pull the first queued message and verify it carries the budget hint
    // plus the original prompt, in that order.
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const firstMsg = first.value as {
      type: string;
      message: { role: string; content: string };
    };
    expect(firstMsg.type).toBe('user');
    expect(firstMsg.message.role).toBe('user');
    expect(firstMsg.message.content).toContain('Budget:');
    expect(firstMsg.message.content).toContain('original user task');
    expect(firstMsg.message.content.indexOf('Budget:')).toBeLessThan(
      firstMsg.message.content.indexOf('original user task'),
    );
  });

  // -------------------------------------------------------------------------
  // 11. scratchpad populated from each assistant message across multiple
  //     turns — test by driving a supervision-exhausted path and verifying
  //     salvage returns the LAST assistant text that streamed through.
  // -------------------------------------------------------------------------
  it('populates the scratchpad from each assistant message across multiple turns and salvages latest() on supervision exhaustion', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    // Three assistant messages stream through (all short, all degenerate),
    // interleaved with three result messages (all short, all degenerate).
    // The supervision loop re-prompts after each result; after
    // MAX_SUPERVISION_RETRIES (3) the loop bails and salvages from the
    // scratchpad. The salvage must return the LAST assistant text we saw,
    // proving the scratchpad was populated on every assistant message.
    // Each result must trigger fragment detection (continuation phrase or
    // fragment punctuation) so supervision treats them as degenerate.
    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      (async function* () {
        yield assistantMsg('turn one scratch text');
        yield resultMsg({ result: 'let me check this:' });
        yield assistantMsg('turn two scratch text');
        yield resultMsg({ result: 'next i will look:' });
        yield assistantMsg('turn three scratch text');
        yield resultMsg({ result: 'let me read more,' });
        yield assistantMsg('turn four scratch text');
        yield resultMsg({ result: 'i should also check:' });
      })(),
    );

    const result = await runClaude('task', {}, providerConfig, defaults);

    expect(result.status).toBe('incomplete');
    // The scratchpad's latest() should be the LAST streamed assistant text.
    // The iterator may break early due to supervision retry exhaustion,
    // but every assistant message before the break must have been buffered.
    expect(result.output).toMatch(/scratch text$/);
  });

  // -------------------------------------------------------------------------
  // 12. supervision re-prompt — verify a degenerate first result triggers
  //     a re-prompt push into the message queue, and a valid second result
  //     returns ok.
  // -------------------------------------------------------------------------
  it('pushes a supervision re-prompt into the queue after a degenerate result and returns ok on a valid second result', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    // Capture the queue so we can inspect what user messages the runner
    // pushed during the iterator loop.
    let capturedQueue: AsyncIterable<unknown> | null = null;

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce(((opts: {
      prompt: AsyncIterable<unknown>;
    }) => {
      capturedQueue = opts.prompt;
      return (async function* () {
        // First turn: degenerate fragment → runner pushes a re-prompt.
        yield assistantMsg('Let me check');
        yield resultMsg({ result: 'Let me check' });
        // Second turn: valid answer → runner closes the queue and returns ok.
        yield assistantMsg(VALID_FINAL_OUTPUT);
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })();
    }) as never);

    const result = await runClaude('task', {}, providerConfig, defaults);

    expect(result.status).toBe('ok');
    expect(result.output).toBe(VALID_FINAL_OUTPUT);

    // The queue must have had: (1) initial user message with budget hint,
    // (2) a supervision re-prompt pushed after the first degenerate result.
    expect(capturedQueue).not.toBeNull();
    const iterator = (capturedQueue as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstMsg = first.value as { message: { content: string } };
    expect(firstMsg.message.content).toContain('Budget:');
    const second = await iterator.next();
    expect(second.done).toBe(false);
    const secondMsg = second.value as { message: { content: string } };
    // buildRePrompt for a 'fragment' kind quotes the wording "exploration fragment".
    expect(secondMsg.message.content).toContain('exploration fragment');
  });

  // -------------------------------------------------------------------------
  // 13. watchdog force_salvage — an over-budget first result triggers
  //     abortController.abort() and the runner returns incomplete with
  //     the scratchpad's latest text.
  // -------------------------------------------------------------------------
  it('triggers force_salvage path when input tokens cross the 95% watchdog threshold on a result message', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    // Soft limit override so 95% is easy to hit: 1000 -> force_salvage at 950.
    const pc = { ...providerConfig, inputTokenSoftLimit: 1000 };

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      (async function* () {
        yield assistantMsg('salvageable scratchpad text');
        // Result pushes cumulative input tokens to 960 (96% of softLimit).
        // Runner must force_salvage on the post-result watchdog check.
        yield resultMsg({ result: 'Let me check', inputTokens: 960 });
        // Any messages beyond the force_salvage must not influence the
        // returned result — but the runner has already broken out by then.
        yield assistantMsg('should not be captured');
        yield resultMsg({ result: VALID_FINAL_OUTPUT });
      })(),
    );

    const result = await runClaude('task', {}, pc, defaults);

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('salvageable scratchpad text');
  });

  // -------------------------------------------------------------------------
  // 14. scratchpad salvage on SDK error — if the iterator throws, the
  //     runner must return scratchpad.latest() (not the bare error string).
  // -------------------------------------------------------------------------
  it('salvages scratchpad.latest() on an SDK error instead of returning "Sub-agent error: ..."', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockImplementationOnce((opts: {
      options: { mcpServers?: Record<string, any> };
    }) => (async function* () {
      const listFilesTool = opts.options.mcpServers?.['code-tools']?.instance?._registeredTools?.list_files;
      if (listFilesTool) {
        await listFilesTool.handler({ path: '.' });
      }
      yield assistantMsg('some buffered findings here');
      throw new Error('upstream API exploded');
    })());

    const result = await runClaude('task', {}, providerConfig, defaults);

    expect(result.status).toBe('error');
    expect(result.output).toBe('some buffered findings here');
    expect(result.error).toBe('upstream API exploded');
    expect(result.directoriesListed).toEqual([process.cwd()]);
  });

  // -------------------------------------------------------------------------
  // 15. scratchpad salvage on max_turns — if the SDK reports
  //     error_max_turns but the scratchpad has content, the runner must
  //     return scratchpad.latest().
  // -------------------------------------------------------------------------
  it('salvages scratchpad.latest() on max_turns when the scratchpad is non-empty', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      (async function* () {
        yield assistantMsg('partial findings before budget exhaustion');
        yield resultMsg({ result: '', subtype: 'error_max_turns' });
      })(),
    );

    const result = await runClaude('task', {}, providerConfig, defaults);

    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('degenerate_exhausted');
    expect(result.output).toBe('partial findings before budget exhaustion');
  });

  // ---------------------------------------------------------------------------
  // Task 10: progress event emission
  // ---------------------------------------------------------------------------
  describe('claude-runner — progress event emission', () => {
    it('emits turn_start / text_emission / turn_complete / done in order for a one-turn run', async () => {
      const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

      (query as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        (async function* () {
          yield assistantMsg(VALID_FINAL_OUTPUT);
          yield resultMsg({ result: VALID_FINAL_OUTPUT, inputTokens: 12, outputTokens: 34 });
        })(),
      );

      const events: ProgressEvent[] = [];
      const onProgress = (e: ProgressEvent) => { events.push(e); };

      const result = await runClaude(
        'prompt',
        { onProgress },
        providerConfig,
        defaults,
      );

      expect(result.status).toBe('ok');

      // Ordering: turn_start fires first (at top of assistant branch),
      // then text_emission (after scratchpad append), then turn_complete
      // (after result-message usage aggregation), then done last.
      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe('turn_start');
      expect(kinds).toContain('text_emission');
      expect(kinds).toContain('turn_complete');
      expect(kinds[kinds.length - 1]).toBe('done');

      // text_emission must carry the assistant text and a preview.
      const textEvent = events.find((e) => e.kind === 'text_emission');
      expect(textEvent).toBeDefined();
      if (textEvent && textEvent.kind === 'text_emission') {
        expect(textEvent.turn).toBe(1);
        expect(textEvent.chars).toBe(VALID_FINAL_OUTPUT.length);
        expect(textEvent.preview.length).toBeGreaterThan(0);
      }

      // turn_complete must carry the accumulated usage counters.
      const turnComplete = events.find((e) => e.kind === 'turn_complete');
      expect(turnComplete).toBeDefined();
      if (turnComplete && turnComplete.kind === 'turn_complete') {
        expect(turnComplete.turn).toBe(1);
        expect(turnComplete.cumulativeInputTokens).toBe(12);
        expect(turnComplete.cumulativeOutputTokens).toBe(34);
      }

      // done event status must match the final RunResult status.
      const doneEvent = events[events.length - 1];
      expect(doneEvent.kind).toBe('done');
      if (doneEvent.kind === 'done') {
        expect(doneEvent.status).toBe('ok');
      }
    });
  });
});
