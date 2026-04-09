import { describe, it, expect } from 'vitest';
import { delegateAll, getEffectiveCapabilities } from '../src/delegate.js';
import type { Provider, ProviderConfig, RunResult, DelegateTask } from '../src/types.js';

function mockProvider(name: string, result: Partial<RunResult>, configOverride?: Partial<ProviderConfig>): Provider {
  const full: RunResult = {
    output: '',
    status: 'ok',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 1,
    files: [],
    ...result,
  };
  return {
    name,
    config: {
      type: 'openai-compatible',
      model: 'mock',
      baseUrl: 'https://mock.example.com/v1',
      ...configOverride,
    },
    run: async () => full,
  };
}

function failProvider(name: string, error: string): Provider {
  return {
    name,
    config: { type: 'openai-compatible', model: 'mock', baseUrl: 'https://mock.example.com/v1' },
    run: async () => { throw new Error(error); },
  };
}

// Helper: build a minimal valid task. Required fields get sensible defaults.
function task(overrides: Partial<DelegateTask> & { provider: Provider; prompt: string }): DelegateTask {
  return {
    tier: 'standard',
    requiredCapabilities: [],
    ...overrides,
  };
}

describe('delegateAll', () => {
  it('runs tasks in parallel and returns all results', async () => {
    const p1 = mockProvider('a', { output: 'result-a' });
    const p2 = mockProvider('b', { output: 'result-b' });

    const results = await delegateAll([
      task({ provider: p1, prompt: 'task a' }),
      task({ provider: p2, prompt: 'task b' }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('result-a');
    expect(results[1].output).toBe('result-b');
  });

  it('isolates errors per task', async () => {
    const good = mockProvider('good', { output: 'ok' });
    const bad = failProvider('bad', 'auth failure');

    const results = await delegateAll([
      task({ provider: good, prompt: 't' }),
      task({ provider: bad, prompt: 't' }),
    ]);

    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('error');
    expect(results[1].error).toBe('auth failure');
  });

  it('returns empty array for empty input', async () => {
    const results = await delegateAll([]);
    expect(results).toEqual([]);
  });

  it('passes options through to provider', async () => {
    let receivedOptions: any;
    const spy: Provider = {
      name: 'spy',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'https://mock.example.com/v1' },
      run: async (_prompt, opts) => {
        receivedOptions = opts;
        return {
          output: '', status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 1, files: [],
        };
      },
    };

    await delegateAll([
      task({ provider: spy, prompt: 't', tools: 'full', maxTurns: 10 }),
    ]);

    expect(receivedOptions.tools).toBe('full');
    expect(receivedOptions.maxTurns).toBe(10);
  });

  it('forwards sandboxPolicy to provider', async () => {
    let receivedOptions: any;
    const spy: Provider = {
      name: 'spy',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'https://mock.example.com/v1' },
      run: async (_prompt, opts) => {
        receivedOptions = opts;
        return {
          output: '', status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 1, files: [],
        };
      },
    };

    await delegateAll([
      task({ provider: spy, prompt: 't', sandboxPolicy: 'none' }),
    ]);

    expect(receivedOptions.sandboxPolicy).toBe('none');
  });
});

describe('delegateAll capability enforcement', () => {
  it('fails fast when a required capability is missing, without calling provider.run', async () => {
    let runCalled = false;
    const provider: Provider = {
      name: 'openai',
      config: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
      run: async () => {
        runCalled = true;
        return {
          output: '', status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 1, files: [],
        };
      },
    };

    const results = await delegateAll([
      task({ provider, prompt: 'fetch weather', requiredCapabilities: ['web_search'] }),
    ]);

    expect(runCalled).toBe(false);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/cannot satisfy requiredCapabilities/);
    expect(results[0].error).toMatch(/web_search/);
  });

  it('proceeds when all required capabilities are available', async () => {
    let runCalled = false;
    const provider: Provider = {
      name: 'codex',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: async () => {
        runCalled = true;
        return {
          output: 'ran', status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 1, files: [],
        };
      },
    };

    // codex auto-enables web_search, so this should pass enforcement
    const results = await delegateAll([
      task({ provider, prompt: 'fetch weather', requiredCapabilities: ['web_search', 'file_read'] }),
    ]);

    expect(runCalled).toBe(true);
    expect(results[0].status).toBe('ok');
    expect(results[0].output).toBe('ran');
  });

  it('lists multiple missing capabilities in the error message', async () => {
    const provider: Provider = {
      name: 'minimal',
      config: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
      run: async () => { throw new Error('should not run'); },
    };

    const results = await delegateAll([
      task({ provider, prompt: 't', requiredCapabilities: ['web_search', 'shell'] }),
    ]);

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/web_search/);
    expect(results[0].error).toMatch(/shell/);
  });

  it('rejects a task requesting shell when the provider defaults to cwd-only sandbox', async () => {
    const provider: Provider = {
      name: 'codex',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: async () => { throw new Error('should not run'); },
    };

    const results = await delegateAll([
      task({ provider, prompt: 't', requiredCapabilities: ['shell'] }),
    ]);

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/shell/);
  });

  it('accepts a task requesting shell when the task overrides sandboxPolicy to none', async () => {
    let runCalled = false;
    const provider: Provider = {
      name: 'codex',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: async () => {
        runCalled = true;
        return {
          output: 'shell ran', status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 1, files: [],
        };
      },
    };

    const results = await delegateAll([
      task({ provider, prompt: 't', sandboxPolicy: 'none', requiredCapabilities: ['shell'] }),
    ]);

    expect(runCalled).toBe(true);
    expect(results[0].status).toBe('ok');
  });

  it('rejects any requiredCapability when tools is none (no tools available)', async () => {
    const provider: Provider = {
      name: 'claude',
      config: { type: 'claude', model: 'claude-opus-4-6' },
      run: async () => { throw new Error('should not run'); },
    };

    const results = await delegateAll([
      task({ provider, prompt: 't', tools: 'none', requiredCapabilities: ['file_read'] }),
    ]);

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/file_read/);
  });
});

describe('getEffectiveCapabilities', () => {
  it('returns empty array when tools are disabled', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = getEffectiveCapabilities(config, { tools: 'none' });
    expect(caps).toEqual([]);
  });

  it('includes shell when per-task sandboxPolicy is none', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = getEffectiveCapabilities(config, { sandboxPolicy: 'none' });
    expect(caps).toContain('shell');
  });

  it('excludes shell when per-task sandboxPolicy is cwd-only even if provider config allows it', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      sandboxPolicy: 'none',
    };
    const caps = getEffectiveCapabilities(config, { sandboxPolicy: 'cwd-only' });
    expect(caps).not.toContain('shell');
  });

  it('inherits provider-level sandboxPolicy when per-task is undefined', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      sandboxPolicy: 'none',
    };
    const caps = getEffectiveCapabilities(config, {});
    expect(caps).toContain('shell');
  });
});
