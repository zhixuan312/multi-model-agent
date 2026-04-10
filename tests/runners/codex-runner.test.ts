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

    const streamEvents = [
      { type: 'response.output_text.delta', delta: 'hello' },
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
    expect(result.output).toBe('hello');
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
    const turn2Events = [
      { type: 'response.output_text.delta', delta: 'final answer' },
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
    expect(result.output).toBe('final answer');
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
});
