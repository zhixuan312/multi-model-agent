import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks for runner modules — must be declared before any dynamic import
// that would resolve those modules. Paths are relative to this test file.
vi.mock('../packages/core/src/runners/claude-runner.js', () => ({
  runClaude: vi.fn(),
}));

vi.mock('../packages/core/src/runners/codex-runner.js', () => ({
  runCodex: vi.fn(),
}));

vi.mock('../packages/core/src/runners/openai-runner.js', () => ({
  runOpenAI: vi.fn(),
}));

// Mock 'openai' default export so openai-compatible provider creation does not
// attempt to instantiate the real SDK.
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    responses: { create: vi.fn() },
  })),
}));

const mockOkResult = {
  output: 'mock output',
  status: 'ok' as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: null },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
};

describe('createProvider dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. createProvider throws when provider name is not in config
  // -------------------------------------------------------------------------
  it('throws when provider name not in config', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');

    expect(() =>
      createProvider('nonexistent', {
        providers: {},
        defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
      }),
    ).toThrow(/not found in config/);
  });

  // -------------------------------------------------------------------------
  // 2. dispatch to runClaude for type='claude'
  // -------------------------------------------------------------------------
  it('dispatch to runClaude for claude type and returns runner result', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');
    const { runClaude } = await import('../packages/core/src/runners/claude-runner.js');

    vi.mocked(runClaude).mockResolvedValue(mockOkResult);

    const provider = createProvider('c', {
      providers: { c: { type: 'claude', model: 'claude-sonnet-4-6' } },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    const result = await provider.run('hello world', { maxTurns: 10 });

    expect(runClaude).toHaveBeenCalledOnce();
    const [prompt, options, providerConfig, defaults] = vi.mocked(runClaude).mock.calls[0]!;
    expect(prompt).toBe('hello world');
    expect(options).toEqual({ maxTurns: 10 });
    expect(providerConfig).toEqual({ type: 'claude', model: 'claude-sonnet-4-6' });
    expect(defaults).toEqual({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' });
    expect(result.status).toBe('ok');
    expect(result.output).toBe('mock output');
  });

  // -------------------------------------------------------------------------
  // 3. dispatch to runCodex for type='codex'
  // -------------------------------------------------------------------------
  it('dispatch to runCodex for codex type and returns runner result', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');
    const { runCodex } = await import('../packages/core/src/runners/codex-runner.js');

    vi.mocked(runCodex).mockResolvedValue({ ...mockOkResult, output: 'codex output' });

    const provider = createProvider('c', {
      providers: { c: { type: 'codex', model: 'gpt-5-codex' } },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    const result = await provider.run('codex prompt');

    expect(runCodex).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
    expect(result.output).toBe('codex output');
  });

  // -------------------------------------------------------------------------
  // 4. dispatch to runOpenAI for type='openai-compatible'
  // -------------------------------------------------------------------------
  it('dispatch to runOpenAI for openai-compatible type and returns runner result', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');
    const { runOpenAI } = await import('../packages/core/src/runners/openai-runner.js');

    vi.mocked(runOpenAI).mockResolvedValue({ ...mockOkResult, output: 'openai output' });

    const provider = createProvider('o', {
      providers: {
        o: { type: 'openai-compatible', model: 'gpt-5', baseUrl: 'https://api.example.com' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    const result = await provider.run('openai prompt');

    expect(runOpenAI).toHaveBeenCalledOnce();
    // The runner is called with (prompt, options, runnerOpts) where runnerOpts
    // contains client, providerConfig, defaults.
    const [, , runnerOpts] = vi.mocked(runOpenAI).mock.calls[0]!;
    expect(runnerOpts.providerConfig).toEqual({
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.example.com',
    });
    expect(result.status).toBe('ok');
    expect(result.output).toBe('openai output');
  });

  // -------------------------------------------------------------------------
  // 5. wraps runner thrown error as { status: 'error', error: containing message }
  //
  // provider.ts wraps ALL errors from runner calls in a try/catch, returning
  // { status: 'error', error: <message> }. The promise resolves (never rejects).
  // -------------------------------------------------------------------------
  it('wraps runner thrown error as status error with error message', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');
    const { runClaude } = await import('../packages/core/src/runners/claude-runner.js');

    vi.mocked(runClaude).mockRejectedValue(new Error('network failure'));

    const provider = createProvider('c', {
      providers: { c: { type: 'claude', model: 'claude-sonnet-4-6' } },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    // Must resolve, not reject — provider.ts catches the runner error.
    const result = await provider.run('prompt');

    expect(result.status).toBe('error');
    expect(result.error).toContain('network failure');
  });

  // -------------------------------------------------------------------------
  // 6. apiKeyEnv resolution: when provider config has apiKeyEnv and the env
  //    var is set, the runner is called (OpenAI client receives the resolved key)
  // -------------------------------------------------------------------------
  it('resolves apiKeyEnv from process.env and calls the runner', async () => {
    const { createProvider } = await import('../packages/core/src/provider.js');
    const { runOpenAI } = await import('../packages/core/src/runners/openai-runner.js');

    vi.mocked(runOpenAI).mockResolvedValue({ ...mockOkResult, output: 'env-resolved' });
    vi.stubEnv('MY_API_KEY', 'secret-123');

    const provider = createProvider('o', {
      providers: {
        o: {
          type: 'openai-compatible',
          model: 'gpt-5',
          baseUrl: 'https://api.example.com',
          apiKeyEnv: 'MY_API_KEY',
        },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    await provider.run('prompt with env-resolved api key');

    expect(runOpenAI).toHaveBeenCalledOnce();
    // Verify the runner received the call — the apiKey is embedded in the
    // OpenAI client created inside provider.ts using process.env[apiKeyEnv].
    const [, , runnerOpts] = vi.mocked(runOpenAI).mock.calls[0]!;
    expect(runnerOpts.providerConfig).toEqual({
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.example.com',
      apiKeyEnv: 'MY_API_KEY',
    });

    vi.unstubAllEnvs();
  });
});
