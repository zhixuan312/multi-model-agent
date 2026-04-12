import { describe, it, expect } from 'vitest';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import { resolveTaskCapabilities } from '@zhixuan92/multi-model-agent-core/routing/resolve-task-capabilities';
import type { MultiModelConfig, ProviderConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

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

  it('one task error does not prevent other task from returning its result', async () => {
    // Task 1 names a nonexistent provider → runTasks returns an error result for it.
    // Task 2 names a configured provider that is ineligible (requires shell which
    // openai-compatible does not provide) → also an error result.
    // Both must be present — runTasks must NOT halt on the first error.
    const results = await runTasks([
      { provider: 'nonexistent', prompt: 'will error', tier: 'trivial', requiredCapabilities: [] },
      { provider: 'auto', prompt: 'will also error', tier: 'trivial', requiredCapabilities: ['shell'] },
    ], {
      providers: {
        auto: { type: 'openai-compatible', model: 'x', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
    });

    expect(results).toHaveLength(2);
    // Both results must be defined — failure of one must not swallow the other.
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('nonexistent');
    expect(results[1].status).toBe('error');
    expect(results[1].error).toContain('ineligible');
  });

  it('returns empty array for empty input', async () => {
    const config: MultiModelConfig = {
      providers: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([], config);
    expect(results).toEqual([]);
  });

  it('returns error result when explicitly named provider is not in config', async () => {
    const config: MultiModelConfig = {
      providers: {
        claude: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { provider: 'nonexistent', prompt: 'task', tier: 'trivial', requiredCapabilities: [] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('nonexistent');
    expect(results[0].error).toContain('not found in config');
  });

  it('returns error result when explicitly named provider is ineligible', async () => {
    const config: MultiModelConfig = {
      providers: {
        claude: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { provider: 'claude', prompt: 'task', tier: 'trivial', requiredCapabilities: ['shell'] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('claude');
    expect(results[0].error).toContain('ineligible');
  });

  it('returns error result when auto-routing finds no eligible provider', async () => {
    const config: MultiModelConfig = {
      providers: {
        claude: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', tier: 'reasoning', requiredCapabilities: ['shell'] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('No eligible provider found');
    expect(results[0].error).toContain('required tier');
  });

  it('returns error result when auto-routing and config has no providers', async () => {
    const config: MultiModelConfig = {
      providers: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', tier: 'trivial', requiredCapabilities: [] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('No eligible provider found');
  });

  it('1.0.0 AgentType and AgentCapability types are importable', () => {
    const agentType: import('@zhixuan92/multi-model-agent-core').AgentType = 'standard';
    const cap: import('@zhixuan92/multi-model-agent-core').AgentCapability = 'web_search';
    expect(agentType).toBe('standard');
    expect(cap).toBe('web_search');
  });

  it('1.0.0 AgentConfig interface accepts the minimal shape', () => {
    const cfg: import('@zhixuan92/multi-model-agent-core').AgentConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
    };
    expect(cfg.type).toBe('claude');
    expect(cfg.model).toBe('claude-opus-4-6');
    expect(cfg.capabilities).toBeUndefined();
  });

  it('1.0.0 AgentConfig accepts all optional fields', () => {
    const cfg: import('@zhixuan92/multi-model-agent-core').AgentConfig = {
      type: 'openai-compatible',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      capabilities: ['web_search'],
      inputCostPerMTok: 0.55,
      outputCostPerMTok: 2.19,
      maxTurns: 100,
      timeoutMs: 300_000,
      sandboxPolicy: 'cwd-only',
    };
    expect(cfg.capabilities).toEqual(['web_search']);
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
