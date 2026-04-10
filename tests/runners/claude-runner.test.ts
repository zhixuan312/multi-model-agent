import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('runClaude', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  const providerConfig = { type: 'claude' as const, model: 'claude-sonnet-4-6' };
  const defaults = { maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const };

  // -------------------------------------------------------------------------
  // 1. ok path
  // -------------------------------------------------------------------------
  it('returns status ok with output and usage when query returns a result message', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield { type: 'assistant' };
      yield {
        type: 'result',
        result: 'hello world',
        modelUsage: {
          'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 20 },
        },
      };
    })());

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('hello world');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
  });

  // -------------------------------------------------------------------------
  // 2. max_turns path
  // -------------------------------------------------------------------------
  it('returns status max_turns when query yields a result message with subtype error_max_turns', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield { type: 'assistant' };
      // Empty result string lets the runner fall back to its
      // synthesized "Agent exceeded max turns (N)." output.
      yield { type: 'result', result: '', subtype: 'error_max_turns' };
    })());

    const result = await runClaude('prompt', {}, providerConfig, defaults);

    expect(result.status).toBe('max_turns');
    expect(result.output).toContain('exceeded max turns');
  });

  // -------------------------------------------------------------------------
  // 3. timeout passthrough — the withTimeout wrapper returns the inner
  //    promise; on real systems the inner SDK honors the abort signal and
  //    settles. We can't fake-timer this end-to-end without rewriting
  //    withTimeout to actually race, so we just verify timeoutMs flows
  //    through to the runner without crashing the option-build path.
  // -------------------------------------------------------------------------
  it('accepts a custom timeoutMs option without crashing the run', async () => {
    const { runClaude } = await import('../../packages/core/src/runners/claude-runner.js');

    (query as ReturnType<typeof vi.fn>).mockReturnValueOnce((async function* () {
      yield { type: 'result', result: 'fast' };
    })());

    const result = await runClaude('prompt', { timeoutMs: 5000 }, providerConfig, defaults);
    expect(result.status).toBe('ok');
    expect(result.output).toBe('fast');
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
        yield { type: 'result', result: 'done' };
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
        yield { type: 'result', result: 'done' };
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
        yield { type: 'result', result: 'done' };
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
        yield { type: 'result', result: 'done' };
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
  it('returns status error with error field when query throws', async () => {
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
        yield {
          type: 'result',
          result: 'out',
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
});