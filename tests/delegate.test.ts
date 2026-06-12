import { describe, it, expect, vi } from 'vitest';

const mockCreateProvider = vi.fn();
vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

import type { MultiModelConfig, RuntimeRunResult } from '@zhixuan92/multi-model-agent-core';
import { executeTask } from '../packages/core/src/lifecycle/task-executor.js';
import { toolConfig } from '../packages/core/src/tools/delegate/tool-config.js';

// A minimal worker result; reviewPolicy 'none' on each task keeps dispatch to a
// single implement stage (no review/rework), so this is all the provider needs.
const okWorker: RuntimeRunResult = {
  output: 'done',
  status: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
  turns: 1,
  filesWritten: [],
  outputIsDiagnostic: false,
  escalationLog: [],
  retryable: false,
  workerStatus: 'done',
} as RuntimeRunResult;

function makeCtx(config: MultiModelConfig) {
  const now = Date.now();
  return {
    config,
    projectContext: { cwd: '/tmp/test-project' },
    contextBlockStore: undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    timing: { startMs: now, timeoutMs: 600_000, deadlineMs: now + 600_000, stallTimeoutMs: 600_000 },
    stall: { controller: new AbortController(), lastEventAtMs: now, fired: false },
  } as any;
}

function provider(slot: string) {
  return {
    name: slot,
    config: { type: 'codex' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async () => okWorker,
  };
}

const defaults = { timeoutMs: 600_000, tools: 'full' as const };

describe('executeTask (delegate route) — dispatch behavior', () => {
  it('collapses multiple tasks into ONE goal-set (single result, sequential)', { timeout: 30_000 }, async () => {
    mockCreateProvider.mockImplementation((slot: string) => provider(slot));
    const config: MultiModelConfig = {
      agents: {
        standard: { type: 'codex', model: 'a-model', baseUrl: 'https://a.example.com/v1' },
        complex: { type: 'codex', model: 'b-model', baseUrl: 'https://b.example.com/v1' },
      },
      defaults,
    };
    const out = await executeTask(toolConfig, makeCtx(config), {
      tasks: [
        { prompt: 'task a', agentType: 'standard', reviewPolicy: 'none' },
        { prompt: 'task b', agentType: 'complex', reviewPolicy: 'none' },
      ],
    });
    // Goal mode: N caller tasks → one goal-set → one result (not N).
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(1);
  });

  it('empty task list fails with empty_plan before dispatch', async () => {
    const config: MultiModelConfig = {
      agents: { standard: { type: 'codex', model: 'x', baseUrl: 'https://example.invalid/v1' } },
      defaults,
    };
    mockCreateProvider.mockImplementation((slot: string) => provider(slot));
    const out = await executeTask(toolConfig, makeCtx(config), { tasks: [] } as any);
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.structuredError?.code ?? results[0]!.error).toContain('empty_plan');
  });

  it('returns an error result when the named agent tier is not configured', async () => {
    const config: MultiModelConfig = {
      agents: { standard: { type: 'claude', model: 'claude-sonnet-4-6' } },
      defaults,
    };
    const out = await executeTask(toolConfig, makeCtx(config), {
      tasks: [{ prompt: 'task', agentType: 'complex', reviewPolicy: 'none' }],
    });
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('agent_not_configured');
  });

  it('returns an error result when config has no agents', async () => {
    const config: MultiModelConfig = { agents: {}, defaults };
    const out = await executeTask(toolConfig, makeCtx(config), {
      tasks: [{ prompt: 'task', agentType: 'standard', reviewPolicy: 'none' }],
    });
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('agent_not_configured');
  });
});

describe('public type surface', () => {
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

  it('RuntimeRunResult carries review statuses and per-phase subreports', () => {
    const result: RuntimeRunResult = {
      output: 'done',
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
      turns: 1,
      filesWritten: [],
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
        deviationsFromBrief: [],
        unresolved: [],
      },
      specReviewReport: {
        summary: 'looks good',
        filesChanged: [],
        deviationsFromBrief: [],
        unresolved: [],
      },
      qualityReviewReport: {
        summary: 'code is clean',
        filesChanged: [],
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
