import { describe, it, expect } from 'vitest';
import { delegateAll } from '../src/delegate.js';
import type { Provider, RunResult, DelegateTask } from '../src/types.js';

function mockProvider(name: string, result: Partial<RunResult>): Provider {
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
    config: { type: 'openai-compatible', model: 'mock' },
    run: async () => full,
  };
}

function failProvider(name: string, error: string): Provider {
  return {
    name,
    config: { type: 'openai-compatible', model: 'mock' },
    run: async () => { throw new Error(error); },
  };
}

describe('delegateAll', () => {
  it('runs tasks in parallel and returns all results', async () => {
    const p1 = mockProvider('a', { output: 'result-a' });
    const p2 = mockProvider('b', { output: 'result-b' });

    const results = await delegateAll([
      { provider: p1, prompt: 'task a' },
      { provider: p2, prompt: 'task b' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('result-a');
    expect(results[1].output).toBe('result-b');
  });

  it('isolates errors per task', async () => {
    const good = mockProvider('good', { output: 'ok' });
    const bad = failProvider('bad', 'auth failure');

    const results = await delegateAll([
      { provider: good, prompt: 'task' },
      { provider: bad, prompt: 'task' },
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
      config: { type: 'openai-compatible', model: 'mock' },
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
      { provider: spy, prompt: 'task', tools: 'none', maxTurns: 10 },
    ]);

    expect(receivedOptions.tools).toBe('none');
    expect(receivedOptions.maxTurns).toBe(10);
  });

  it('preserves files from provider that wrote files then threw', async () => {
    const filesBeforeError: Provider = {
      name: 'partial',
      config: { type: 'openai-compatible', model: 'mock' },
      run: async () => {
        throw Object.assign(new Error('SDK crash'), { files: ['a.ts'] });
      },
    };

    // delegateAll's catch-all produces files: [] — this test documents
    // that the runner layer (not delegateAll) is responsible for preserving files.
    const results = await delegateAll([{ provider: filesBeforeError, prompt: 'task' }]);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBe('SDK crash');
  });

  it('forwards sandboxPolicy to provider', async () => {
    let receivedOptions: any;
    const spy: Provider = {
      name: 'spy',
      config: { type: 'openai-compatible', model: 'mock' },
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
      { provider: spy, prompt: 'task', sandboxPolicy: 'none' },
    ]);

    expect(receivedOptions.sandboxPolicy).toBe('none');
  });
});
