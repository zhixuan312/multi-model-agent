import { describe, it, expect } from 'vitest';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

const defaultConfig: MultiModelConfig = {
  defaults: { timeoutMs: 600000, tools: 'full' },
};

describe('runTasks', () => {
  it('runs tasks in parallel and returns all results', async () => {
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'openai-compatible', model: 'a-model', baseUrl: 'https://a.example.com/v1' },
        complex: { type: 'openai-compatible', model: 'b-model', baseUrl: 'https://b.example.com/v1' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task a', agentType: 'standard' as const, requiredCapabilities: [] },
      { prompt: 'task b', agentType: 'complex' as const, requiredCapabilities: [] },
    ], config);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBeDefined();
  });

  it('one task error does not prevent other task from returning its result', async () => {
    const results = await runTasks([
      { prompt: 'will error', agentType: 'standard' as const, requiredCapabilities: [] },
      { prompt: 'will also error', agentType: 'standard' as const, requiredCapabilities: ['web_search'] },
    ], {
      agents: {
        standard: { type: 'openai-compatible', model: 'x', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: { timeoutMs: 600_000, tools: 'full' },
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('error');
    expect(results[1].status).toBe('error');
    expect(results[1].error).toContain('capability_missing');
  });

  it('returns empty array for empty input', async () => {
    const config: MultiModelConfig = {
      agents: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([], config);
    expect(results).toEqual([]);
  });

  it('returns error result when explicitly named agent is not in config', async () => {
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-6' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', agentType: 'complex' as const, requiredCapabilities: [] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('capability_missing');
  });

  it('returns error result when explicitly named agent is ineligible', async () => {
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', agentType: 'standard' as const, requiredCapabilities: ['web_search'] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('capability_missing');
  });

  it('returns error result when auto-routing finds no eligible agent', async () => {
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', agentType: 'standard' as const, requiredCapabilities: ['web_search'] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('capability_missing');
  });

  it('returns error result when auto-routing and config has no agents', async () => {
    const config: MultiModelConfig = {
      agents: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', agentType: 'standard' as const, requiredCapabilities: [] },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('capability_missing');
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

  it('1.0.0 runTasks refuses a bad brief under normalize mode', async () => {
    const results = await runTasks(
      [{ prompt: 'Fix the thing.', agentType: 'standard', briefQualityPolicy: 'normalize' }],
      {
        agents: {
          standard: { type: 'openai-compatible', model: 'x', baseUrl: 'https://example.invalid/v1' },
          complex: { type: 'claude', model: 'claude-opus-4-6' },
        },
        defaults: { timeoutMs: 600_000, tools: 'full' },
      },
    );
    expect(results[0].status).toBe('brief_too_vague');
    expect(results[0].errorCode).toBe('brief_too_vague');
    expect(results[0].retryable).toBe(false);
    expect(results[0].briefQualityWarnings?.length).toBeGreaterThan(0);
  });

  it('1.0.0 runTasks sets errorCode on capability_missing', async () => {
    const results = await runTasks(
      [{ prompt: 'task', agentType: 'standard', requiredCapabilities: ['web_search'] }],
      {
        agents: {
          standard: { type: 'openai-compatible', model: 'x', baseUrl: 'https://example.invalid/v1' },
          complex: { type: 'openai-compatible', model: 'y', baseUrl: 'https://example.invalid/v2' },
        },
        defaults: { timeoutMs: 600_000, tools: 'full' },
      },
    );
    expect(results[0].status).toBe('error');
    expect(results[0].errorCode).toBe('capability_missing');
  });

  it('1.0.0 RunResult carries review statuses and per-phase subreports', () => {
    const result: import('@zhixuan92/multi-model-agent-core').RunResult = {
      output: 'done',
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      briefQualityWarnings: [],
      retryable: false,
      workerStatus: 'done',
      specReviewStatus: 'approved',
      qualityReviewStatus: 'approved',
      agents: {
        normalizer: 'skipped',
        implementer: 'standard',
        specReviewer: 'complex',
        qualityReviewer: 'complex',
      },
      implementationReport: {
        summary: 'did it',
        filesChanged: [],
        normalizationDecisions: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
      specReviewReport: {
        summary: 'looks good',
        filesChanged: [],
        normalizationDecisions: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
      qualityReviewReport: {
        summary: 'code is clean',
        filesChanged: [],
        normalizationDecisions: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
    };
    expect(result.workerStatus).toBe('done');
    expect(result.specReviewStatus).toBe('approved');
    expect(result.qualityReviewStatus).toBe('approved');
    expect(result.agents?.implementer).toBe('standard');
    expect(result.agents?.specReviewer).toBe('complex');
  });

  it('1.0.0 TaskSpec accepts reviewPolicy and maxReviewRounds', () => {
    const task: import('@zhixuan92/multi-model-agent-core').TaskSpec = {
      prompt: 'do X',
      agentType: 'standard',
      reviewPolicy: 'full',
      maxReviewRounds: 2,
    };
    expect(task.reviewPolicy).toBe('full');
    expect(task.maxReviewRounds).toBe(2);
  });
});
