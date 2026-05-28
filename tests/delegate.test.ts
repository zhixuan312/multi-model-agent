import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import type { MultiModelConfig, RuntimeRunResult, AgentType, Provider } from '@zhixuan92/multi-model-agent-core';
import { __setCoreTestProviderOverrideMap } from '@zhixuan92/multi-model-agent-core';
import { executeTask } from '../packages/core/src/lifecycle/task-executor.js';
import { toolConfig } from '../packages/core/src/tools/delegate/tool-config.js';

// Inject fake providers via the supported __setCoreTestProviderOverrideMap seam
// (gated by MMAGENT_TEST_PROVIDER_OVERRIDE=1) instead of vi.mock on the
// provider-factory module — under Bun mock.module is sticky/process-global and
// leaked the createProvider mock into later tests. resolveAgent throws
// agent_not_configured from its own config check BEFORE createProvider, so
// overriding both slots is safe: unconfigured-tier tests still hit that path.

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
  let prevEnv: string | undefined;
  beforeAll(() => {
    prevEnv = process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
    process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
  });
  beforeEach(() => {
    __setCoreTestProviderOverrideMap(new Map<AgentType, Provider>([
      ['standard', provider('standard') as unknown as Provider],
      ['complex', provider('complex') as unknown as Provider],
    ]));
  });
  afterEach(() => { __setCoreTestProviderOverrideMap(null); });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
    else process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = prevEnv;
  });

  it('runs tasks in parallel and returns all results', { timeout: 30_000 }, async () => {
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
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(2);
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBeDefined();
  });

  it('one task error does not prevent the other task from returning its result', { timeout: 30_000 }, async () => {
    const config: MultiModelConfig = {
      agents: { standard: { type: 'codex', model: 'x', baseUrl: 'https://example.invalid/v1' } },
      defaults,
    };
    const out = await executeTask(toolConfig, makeCtx(config), {
      tasks: [
        { prompt: 'runs', agentType: 'standard', reviewPolicy: 'none' },
        { prompt: 'unconfigured tier', agentType: 'complex', reviewPolicy: 'none' },
      ],
    });
    const results = out.results as RuntimeRunResult[];
    expect(results).toHaveLength(2);
    expect(results[0].status).toBeDefined();
    expect(results[1].status).toBe('error');
    expect(results[1].error).toContain('agent_not_configured');
  });

  it('returns empty results for empty task list', async () => {
    const config: MultiModelConfig = { agents: {}, defaults };
    const out = await executeTask(toolConfig, makeCtx(config), { tasks: [] });
    const results = Array.isArray(out.results) ? out.results : [];
    expect(results).toHaveLength(0);
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
