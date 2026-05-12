import { describe, it, expect } from 'vitest';
import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/task-runner';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

const defaultConfig: MultiModelConfig = {
  defaults: { timeoutMs: 600000, tools: 'full' },
};

describe('runTasks', () => {
  it('runs tasks in parallel and returns all results', async () => {
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'codex', model: 'a-model', baseUrl: 'https://a.example.com/v1' },
        complex: { type: 'codex', model: 'b-model', baseUrl: 'https://b.example.com/v1' },
      },
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task a', agentType: 'standard' as const },
      { prompt: 'task b', agentType: 'complex' as const },
    ], config);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBeDefined();
  });

  it('one task error does not prevent other task from returning its result', async () => {
    const results = await runTasks([
      { prompt: 'will error', agentType: 'standard' as const },
      { prompt: 'will also error', agentType: 'complex' as const },
    ], {
      agents: {
        standard: { type: 'codex', model: 'x', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: { timeoutMs: 600_000, tools: 'full' },
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBe('error');
    expect(results[1].error).toContain('agent_not_configured');
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
      { prompt: 'task', agentType: 'complex' as const },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('agent_not_configured');
  });

  it('returns error result when config has no agents', async () => {
    const config: MultiModelConfig = {
      agents: {},
      defaults: defaultConfig.defaults,
    };
    const results = await runTasks([
      { prompt: 'task', agentType: 'standard' as const },
    ], config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('agent_not_configured');
  });

  it('AgentType type is importable', () => {
    const agentType: import('@zhixuan92/multi-model-agent-core').AgentType = 'standard';
    expect(agentType).toBe('standard');
  });

  it('AgentConfig interface accepts the minimal shape', () => {
    const cfg: import('@zhixuan92/multi-model-agent-core').AgentConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
    };
    expect(cfg.type).toBe('claude');
    expect(cfg.model).toBe('claude-opus-4-6');
  });

  it('AgentConfig accepts all optional fields', () => {
    const cfg: import('@zhixuan92/multi-model-agent-core').AgentConfig = {
      type: 'codex',
      model: 'deepseek-r1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      inputCostPerMTok: 0.55,
      outputCostPerMTok: 2.19,
      timeoutMs: 300_000,
      sandboxPolicy: 'cwd-only',
    };
    expect(cfg.type).toBe('codex');
  });

  it('runTasks strict briefQualityPolicy no longer blocks execution', async () => {
    const results = await runTasks(
      [{ prompt: 'Fix the thing.', agentType: 'standard', briefQualityPolicy: 'strict' }],
      {
        agents: {
          standard: { type: 'codex', model: 'x', baseUrl: 'https://example.invalid/v1' },
          complex: { type: 'claude', model: 'claude-opus-4-6' },
        },
        defaults: { timeoutMs: 600_000, tools: 'full' },
      },
    );
    expect(results[0].status).toBeDefined();
  });

  it('RunResult carries review statuses and per-phase subreports', () => {
    const result: RunResult = {
      output: 'done',
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      retryable: false,
      workerStatus: 'done',
      specReviewStatus: 'approved',
      qualityReviewStatus: 'approved',
      agents: {
        implementer: 'standard',
        specReviewer: 'complex',
        qualityReviewer: 'complex',
      },
      implementationReport: {
        summary: 'did it',
        filesChanged: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
      specReviewReport: {
        summary: 'looks good',
        filesChanged: [],
        validationsRun: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
      qualityReviewReport: {
        summary: 'code is clean',
        filesChanged: [],
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

  it('TaskSpec accepts reviewPolicy', () => {
    const task: import('@zhixuan92/multi-model-agent-core').TaskSpec = {
      prompt: 'do X',
      agentType: 'standard',
      reviewPolicy: 'full',
    };
    expect(task.reviewPolicy).toBe('full');
  });
});
