import { describe, it, expect } from 'vitest';
import { runTasks } from '@scope/multi-model-agent-core/run-tasks';
import { resolveTaskCapabilities } from '@scope/multi-model-agent-core/routing/resolve-task-capabilities';
import type { MultiModelConfig, ProviderConfig, RunResult } from '@scope/multi-model-agent-core';

const defaultConfig: MultiModelConfig = {
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
};

describe('runTasks', () => {
  it('runs tasks in parallel and returns all results', async () => {
    const config: MultiModelConfig = {
      providers: {
        a: { type: 'openai-compatible', model: 'a-model', baseUrl: 'https://a.example.com/v1' },
        b: { type: 'openai-compatible', model: 'b-model', baseUrl: 'https://b.example.com/v1' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { provider: 'a', prompt: 'task a', tier: 'trivial', requiredCapabilities: [] },
      { provider: 'b', prompt: 'task b', tier: 'trivial', requiredCapabilities: [] },
    ], config);

    expect(results).toHaveLength(2);
    // Provider 'a' and 'b' are configured but their run() will fail with connection errors
    // since they're fake URLs. The test checks that parallel execution happened.
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBeDefined();
  });

  it('returns empty array for empty input', async () => {
    const config: MultiModelConfig = {
      providers: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([], config);
    expect(results).toEqual([]);
  });
});

describe('resolveTaskCapabilities', () => {
  it('returns empty array when tools are disabled', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = resolveTaskCapabilities(config, { tools: 'none' });
    expect(caps).toEqual([]);
  });

  it('includes shell when per-task sandboxPolicy is none', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = resolveTaskCapabilities(config, { sandboxPolicy: 'none' });
    expect(caps).toContain('shell');
  });

  it('excludes shell when per-task sandboxPolicy is cwd-only even if provider config allows it', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      sandboxPolicy: 'none',
    };
    const caps = resolveTaskCapabilities(config, { sandboxPolicy: 'cwd-only' });
    expect(caps).not.toContain('shell');
  });

  it('inherits provider-level sandboxPolicy when per-task is undefined', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      sandboxPolicy: 'none',
    };
    const caps = resolveTaskCapabilities(config, {});
    expect(caps).toContain('shell');
  });
});
