import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockResponsesCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    responses: { create: mockResponsesCreate },
  }));
  return { default: MockOpenAI };
});

vi.mock('../../packages/core/src/auth/codex-oauth.js', () => ({
  getCodexAuth: vi.fn(),
}));

vi.mock('../../packages/core/src/tools/definitions.js', () => ({
  createToolImplementations: vi.fn(() => ({
    readFile: vi.fn().mockResolvedValue('file content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    glob: vi.fn().mockResolvedValue(['a.ts']),
    grep: vi.fn().mockResolvedValue('1: match'),
    listFiles: vi.fn().mockResolvedValue(['a.ts']),
    runShell: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
  })),
}));

describe('runCodex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const defaults = { maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const };

  // ─── 1. error when no credentials ────────────────────────────────────
  // createCodexClient is called BEFORE the runner's try/catch, so missing
  // credentials surface as a thrown error rather than a status='error' result.
  it('throws when no Codex credentials are available', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue(null);
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
      await expect(
        runCodex(
          'prompt',
          {},
          { type: 'codex', model: 'gpt-5-codex' },
          defaults,
        ),
      ).rejects.toThrow(/No Codex credentials found/);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  // ─── 2. responses.create called when OAuth credentials available ─────────────
  it('calls client.responses.create when OAuth credentials are available', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'oauth-token', accountId: 'acct-1' });
    mockResponsesCreate.mockReturnValueOnce(
      (async function* () {
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })() as any,
    );
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    await runCodex('prompt', {}, { type: 'codex', model: 'gpt-5-codex' }, defaults);
    expect(mockResponsesCreate).toHaveBeenCalled();
  });

  // ─── 3. hostedTools=[] opts out of web_search ─────────────────────────────────
  it('hostedTools=[] opts out of web_search — web_search NOT in tools', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    let capturedParams: any;
    mockResponsesCreate.mockImplementationOnce((params: any) => {
      capturedParams = params;
      return (async function* () {
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })();
    });
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    await runCodex(
      'prompt',
      { tools: 'full' },
      { type: 'codex', model: 'gpt-5-codex', hostedTools: [] },
      defaults,
    );
    // hosted tools are { type: 'web_search' } objects, not function tools
    const hostedTools = capturedParams.tools?.filter((t: any) => t.type !== 'function') ?? [];
    expect(hostedTools.some((t: any) => t.type === 'web_search')).toBe(false);
  });

  // ─── 4. hostedTools undefined → web_search auto-enabled ─────────────────────
  it('hostedTools=undefined auto-enables web_search — web_search present', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    let capturedParams: any;
    mockResponsesCreate.mockImplementationOnce((params: any) => {
      capturedParams = params;
      return (async function* () {
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })();
    });
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    // hostedTools is not set on providerConfig → defaults to ['web_search']
    await runCodex(
      'prompt',
      { tools: 'full' },
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );
    const hostedTools = capturedParams.tools?.filter((t: any) => t.type !== 'function') ?? [];
    expect(hostedTools.some((t: any) => t.type === 'web_search')).toBe(true);
  });

  // ─── 5. sandboxPolicy='cwd-only' → no run_shell function tool ────────────────
  it('sandboxPolicy=cwd-only excludes run_shell from tools', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    let capturedParams: any;
    mockResponsesCreate.mockImplementationOnce((params: any) => {
      capturedParams = params;
      return (async function* () {
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })();
    });
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    await runCodex(
      'prompt',
      { tools: 'full', sandboxPolicy: 'cwd-only' },
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );
    // run_shell is only added when sandboxPolicy !== 'cwd-only'
    const functionTools = capturedParams.tools?.filter(
      (t: any) => t.type === 'function' && t.name === 'run_shell',
    ) ?? [];
    expect(functionTools).toHaveLength(0);
  });

  // ─── 6. max_turns when maxTurns=1 exhausted in tool-call loop ────────────────
  it('returns max_turns when maxTurns exhausted with tool-call loop', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Two turns of tool calls — maxTurns=1 should stop after first turn
    const streamEvents = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: '1', name: 'read_file', arguments: '{}' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: '1', name: 'read_file', arguments: '{}' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    mockResponsesCreate.mockReturnValueOnce(
      (async function* () {
        for (const e of streamEvents) yield e;
      })() as any,
    );

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      { maxTurns: 1 },
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );
    expect(result.status).toBe('max_turns');
    expect(result.turns).toBe(1);
  });

  // ─── 7. ok with text output and usage on single-turn response ────────────────
  it('returns ok with text output and usage for single-turn response', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Text must end in terminal punctuation to pass validateCompletion's
    // short-response branch (otherwise it would be classified as
    // no_terminator and trigger a supervision re-prompt).
    const streamEvents = [
      { type: 'response.output_text.delta', delta: 'hello.' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 10 } },
      },
    ];
    mockResponsesCreate.mockReturnValueOnce(
      (async function* () {
        for (const e of streamEvents) yield e;
      })() as any,
    );

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );
    expect(result.status).toBe('ok');
    expect(result.output).toBe('hello.');
    // usage extracted from response.usage using snake_case keys
    expect(result.usage.inputTokens).toBe(5);
    expect(result.usage.outputTokens).toBe(10);
  });

  // ─── 8. error status when responses.create rejects ───────────────────────────
  it('returns error status when responses.create rejects with HTTP error', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    mockResponsesCreate.mockRejectedValueOnce(new Error('400 Bad Request'));
    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
  });

  // ─── 9. multi-turn replay must NOT resend unpersisted server items ───────────
  // Regression test for the store:false 404 bug:
  //   "Item with id 'rs_...' not found. Items are not persisted when
  //    `store` is set to false."
  // The runner sends store:false, so the server does not persist reasoning,
  // message, or any other server-generated items. Replaying them by reference
  // (or even inline with their server `id`) causes a 404 on turn 2.
  //
  // Contract: turn 2's `input` must contain the original user prompt,
  // function_call items REBUILT from protocol fields only (no `id`), and
  // function_call_output items we generated locally — and must NOT contain
  // reasoning items or any item carrying an `rs_*` / `msg_*` id.
  it('multi-turn replay drops reasoning items and only resends fresh function_call items', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Capture every responses.create call's params so we can inspect each
    // turn's `input` payload independently.
    const capturedParams: unknown[] = [];

    // Turn 1: server emits a reasoning item (rs_ id), a function_call item
    // (also carries a server `id`), and completes. The model is asking us to
    // run `read_file`.
    const turn1Events = [
      {
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'rs_server_thinking_001' },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'rs_server_thinking_001',
          summary: [{ type: 'summary_text', text: 'I should read the file' }],
        },
      },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_server_id_001', call_id: 'call_1', name: 'read_file' },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_server_id_001',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"x.ts"}',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];

    // Turn 2: server returns a final text response, no more tool calls.
    // Trailing period ensures validateCompletion's short-response branch
    // accepts it without a supervision re-prompt.
    const turn2Events = [
      { type: 'response.output_text.delta', delta: 'final answer.' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 2 } },
      },
    ];

    mockResponsesCreate
      .mockImplementationOnce((params: unknown) => {
        capturedParams.push(params);
        return (async function* () {
          for (const e of turn1Events) yield e;
        })();
      })
      .mockImplementationOnce((params: unknown) => {
        capturedParams.push(params);
        return (async function* () {
          for (const e of turn2Events) yield e;
        })();
      });

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    expect(result.status).toBe('ok');
    expect(result.output).toBe('final answer.');
    expect(capturedParams).toHaveLength(2);

    const turn2Input = (capturedParams[1] as { input: unknown[] }).input;

    // (a) Reasoning items must be dropped — replaying them by their unpersisted
    //     `rs_*` id is exactly what triggered the 404.
    const reasoningItems = turn2Input.filter(
      (i) => (i as { type?: string }).type === 'reasoning',
    );
    expect(reasoningItems).toHaveLength(0);

    // (b) No item in turn 2's input may carry a server-generated `rs_*` or
    //     `fc_*` id field. We rebuild function_call items from protocol fields
    //     only (call_id/name/arguments) so the server has nothing to look up.
    const itemsWithServerId = turn2Input.filter((i) => {
      const id = (i as { id?: string }).id;
      return typeof id === 'string' && (id.startsWith('rs_') || id.startsWith('fc_'));
    });
    expect(itemsWithServerId).toHaveLength(0);

    // (c) The function_call from turn 1 MUST be present (rebuilt) so its
    //     paired function_call_output is valid.
    const functionCalls = turn2Input.filter(
      (i) => (i as { type?: string }).type === 'function_call',
    );
    expect(functionCalls).toHaveLength(1);
    expect((functionCalls[0] as { call_id: string }).call_id).toBe('call_1');
    expect((functionCalls[0] as { name: string }).name).toBe('read_file');

    // (d) The locally-constructed function_call_output for call_1 MUST be
    //     present (the runner's tool-execution loop pushes it).
    const functionOutputs = turn2Input.filter(
      (i) => (i as { type?: string }).type === 'function_call_output',
    );
    expect(functionOutputs).toHaveLength(1);
    expect((functionOutputs[0] as { call_id: string }).call_id).toBe('call_1');
  });

  // ─── 10. Task 5: system prompt uses buildSystemPrompt() output ──────────────
  it('passes buildSystemPrompt() output as instructions (not the user prompt)', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });
    const { buildSystemPrompt, buildBudgetHint } = await import(
      '../../packages/core/src/runners/prevention.js'
    );

    let capturedParams: any;
    mockResponsesCreate.mockImplementationOnce((params: any) => {
      capturedParams = params;
      return (async function* () {
        yield { type: 'response.output_text.delta', delta: 'done.' };
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })();
    });

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    await runCodex(
      'what is the meaning of life',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    // instructions === system prompt (the pre-Task-5 bug was passing the user
    // prompt as `instructions`)
    expect(capturedParams.instructions).toBe(buildSystemPrompt());
    // The user message is the budget hint + original prompt
    const firstInput = capturedParams.input[0];
    const budgetHint = buildBudgetHint({ maxTurns: defaults.maxTurns });
    expect(firstInput.content).toBe(`${budgetHint}\n\nwhat is the meaning of life`);
  });

  // ─── 11. Task 5: degenerate → retry → valid → ok (supervision re-prompt) ────
  it('supervision re-prompt recovers from a degenerate first turn', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    const capturedParams: any[] = [];
    // Turn 1: fragment ending in continuation phrase -> supervision re-prompts
    mockResponsesCreate
      .mockImplementationOnce((params: any) => {
        capturedParams.push(params);
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'let me check' };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      })
      // Turn 2: model follows up with valid answer (ends with period)
      .mockImplementationOnce((params: any) => {
        capturedParams.push(params);
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'Here is the real answer.' };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 2 } },
          };
        })();
      });

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    expect(result.status).toBe('ok');
    expect(result.output).toBe('Here is the real answer.');
    expect(capturedParams).toHaveLength(2);

    // Turn 2's input must contain the supervision re-prompt as a user message.
    const turn2Input = capturedParams[1].input as any[];
    const userMsgs = turn2Input.filter((i) => i.role === 'user');
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    // The re-prompt message is the second (or later) user message.
    const rePromptMsg = userMsgs[userMsgs.length - 1];
    expect(typeof rePromptMsg.content).toBe('string');
    expect(rePromptMsg.content).toMatch(/exploration fragment|let me check/);
  });

  // ─── 12. Task 5: supervision exhaustion salvages scratchpad ─────────────────
  it('returns scratchpad salvage when supervision retries are exhausted', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Four identical-pattern degenerate turns: the first seeds
    // lastDegenerateOutput, retries 1/2/3 exhaust the budget -> incomplete.
    // Each turn emits a DIFFERENT fragment text so the same-output early-out
    // doesn't fire; we want to hit MAX_SUPERVISION_RETRIES specifically.
    const fragments = [
      'exploring next',
      'next i will',
      'let me look',
      'i should also',
    ];
    for (const frag of fragments) {
      mockResponsesCreate.mockImplementationOnce(() => {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: frag };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      });
    }

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    expect(result.status).toBe('incomplete');
    // Scratchpad salvage returns the MOST RECENT buffered emission.
    expect(result.output).toBe(fragments[fragments.length - 1]);
  });

  // ─── 13. Task 5: watchdog force_salvage at 95% ─────────────────────────────
  it('returns incomplete with scratchpad salvage when watchdog fires force_salvage', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Soft limit 100, turn emits 96 input tokens -> ratio 0.96 >= 0.95 -> force_salvage.
    mockResponsesCreate.mockImplementationOnce(() => {
      return (async function* () {
        yield { type: 'response.output_text.delta', delta: 'partial progress notes' };
        yield {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 96, output_tokens: 1 } },
        };
      })();
    });

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex', inputTokenSoftLimit: 100 },
      defaults,
    );

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('partial progress notes');
  });

  // ─── 14. Task 5: error path salvages scratchpad ─────────────────────────────
  it('salvages scratchpad on error after buffering earlier text', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    // Turn 1: emit text + tool_call so the loop continues to turn 2.
    // Turn 2: throw to trip the error path.
    mockResponsesCreate
      .mockImplementationOnce(() => {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'useful partial findings' };
          yield {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'c1',
              name: 'read_file',
              arguments: '{"path":"a.ts"}',
            },
          };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      })
      .mockRejectedValueOnce(new Error('Request was aborted'));

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    // Task 7: "Request was aborted" is classified as api_aborted (not the
    // generic 'error') so the escalation orchestrator can recognise abort
    // conditions specifically.
    expect(result.status).toBe('api_aborted');
    // Scratchpad salvage: the buffered turn-1 text is returned as the output,
    // NOT swallowed as "Sub-agent error: ...".
    expect(result.output).toBe('useful partial findings');
    expect(result.error).toBeDefined();
  });

  // ─── 15. Task 5: abort-path error message is not misleading ────────────────
  // Regression test for the 2026-04-10 Fate dispatch: the error formatter
  // appended "last response status: completed" from a previous successful
  // turn, making the abort look like it originated from a completed response.
  // The fix: only include `last response status` if it was captured on the
  // CURRENT (failing) turn.
  it('abort-path error message does NOT append stale lastResponseStatus from a previous turn', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    mockResponsesCreate
      // Turn 1: completes successfully with a tool call so the loop continues
      .mockImplementationOnce(() => {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'intermediate notes' };
          yield {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'c1',
              name: 'read_file',
              arguments: '{"path":"a.ts"}',
            },
          };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      })
      // Turn 2: throws an abort BEFORE any response.completed event.
      .mockRejectedValueOnce(new Error('Request was aborted'));

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    // Task 7: "Request was aborted" is classified as api_aborted. The
    // turn-scoped lastResponseStatus disambiguation (Task 5) is orthogonal
    // to this status and still runs below.
    expect(result.status).toBe('api_aborted');
    // Pre-fix: error looked like "Request was aborted | last response status: completed"
    // Post-fix: the `| last response status: completed` suffix must NOT appear,
    // because that status belongs to turn 1, not to the failed turn 2.
    expect(result.error).not.toMatch(/\| last response status:/);
    // If we emit a disambiguating note instead, it must clearly describe it
    // as a previous (separate) request.
    if (result.error && /previous request/.test(result.error)) {
      expect(result.error).toMatch(/unrelated to this failure/);
    }
  });

  // ─── 16. Task 5: first-turn empty output still gets retries (sentinel fix) ──
  it('first-turn empty output is retried, not short-circuited by same-output early-out', async () => {
    const { getCodexAuth } = await import('../../packages/core/src/auth/codex-oauth.js');
    vi.mocked(getCodexAuth).mockReturnValue({ accessToken: 'tok', accountId: 'a' });

    mockResponsesCreate
      // Turn 1: completely empty final message (no tool calls, no text)
      .mockImplementationOnce(() => {
        return (async function* () {
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 0 } },
          };
        })();
      })
      // Turn 2: the re-prompt elicits a proper final answer
      .mockImplementationOnce(() => {
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'Here is the answer.' };
          yield {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      });

    const { runCodex } = await import('../../packages/core/src/runners/codex-runner.js');
    const result = await runCodex(
      'prompt',
      {},
      { type: 'codex', model: 'gpt-5-codex' },
      defaults,
    );

    // If lastDegenerateOutput had been initialised to '' instead of null, the
    // same-output early-out would fire on turn 1's empty output (''==='') and
    // break out as incomplete before the re-prompt ran. Sentinel `null` means
    // the first-turn degeneracy gets a real retry.
    expect(result.status).toBe('ok');
    expect(result.output).toBe('Here is the answer.');
  });
});
