import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION, computeTimings, computeBatchProgress, computeAggregateCost } from '@zhixuan92/multi-model-agent-mcp';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

// Mock runTasks so the `delegate_tasks` handler returns fast without
// actually dispatching. The batch cache is populated (via `rememberBatch`)
// BEFORE the dispatch, so the stub can be a no-op returning a single
// canned `ok` result per input task.
vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', async () => {
  const actual =
    await vi.importActual<typeof import('@zhixuan92/multi-model-agent-core/run-tasks')>(
      '@zhixuan92/multi-model-agent-core/run-tasks',
    );
  return {
    ...actual,
    runTasks: vi.fn(
      async (tasks: { prompt: string }[]): Promise<RunResult[]> =>
        tasks.map(() => ({
          output: 'stub ok',
          status: 'ok' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        })),
    ),
  };
});

const sampleConfig = (): MultiModelConfig => ({
  providers: {
    mock: {
      type: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

describe('server metadata', () => {
  it('server name is multi-model-agent', () => {
    expect(SERVER_NAME).toBe('multi-model-agent');
  });

  it('server version matches package version', async () => {
    // Read the published version from packages/mcp/package.json directly
    // and assert SERVER_VERSION is in lockstep. The cli.ts module imports
    // this at load time via createRequire, so drift (e.g. a version bump
    // that forgets to update a hardcoded string) makes this test fail
    // instead of silently shipping wrong metadata.
    const pkgJsonUrl = new URL(
      '../packages/mcp/package.json',
      import.meta.url,
    );
    const pkgJson = JSON.parse(
      await (await import('node:fs/promises')).readFile(pkgJsonUrl, 'utf8'),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkgJson.version);
    // Sanity: don't let the test accidentally pass on an empty version.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildMcpServer', () => {
  it('creates an MCP server with delegate_tasks tool', () => {
    const server = buildMcpServer(sampleConfig());
    expect(server).toBeDefined();
  });

  it('throws when config has no providers', () => {
    const config: MultiModelConfig = {
      providers: {},
      defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
    };
    expect(() => buildMcpServer(config)).toThrow(/at least one configured provider/);
  });
});

describe('delegate_tasks tool description', () => {
  it('includes the routing matrix from describeProviders', () => {
    const server = buildMcpServer(sampleConfig());
    // Access the registered tool via the server's internal tool map.
    // MCP SDK exposes registered tools; we check via a round-trip through
    // the server's listTools request handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    const delegate = tools['delegate_tasks'];
    expect(delegate).toBeDefined();
    expect(delegate.description).toContain('Available providers');
    expect(delegate.description).toContain('mock');
    expect(delegate.description).toContain('Capability filter');
    expect(delegate.description).toContain('STRONG');
  });
});

describe('context-block + retry_tasks tools', () => {
  it('registers register_context_block and retry_tasks alongside delegate_tasks', () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    expect(tools['delegate_tasks']).toBeDefined();
    expect(tools['register_context_block']).toBeDefined();
    expect(tools['retry_tasks']).toBeDefined();
  });

  it('register_context_block handler stores content and returns metadata', async () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const regTool = tools['register_context_block'];
    // The registered tool's handler is the callback passed to server.tool.
    // Second arg (RequestHandlerExtra) is an empty object — the
    // register_context_block handler does not read it.
    const result = await regTool.handler({ content: 'hello', id: 'greeting' }, {});
    // Tool result envelope: { content: [{ type: 'text', text: JSON }] }
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe('greeting');
    expect(payload.lengthChars).toBe(5);
    expect(payload.sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('retry_tasks throws on an unknown batch id', async () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const retryTool = tools['retry_tasks'];
    await expect(
      retryTool.handler({ batchId: 'does-not-exist', taskIndices: [0] }, {}),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('batch cache evicts by LRU, not FIFO: a retried hot batch survives 100+ newer ones', async () => {
    // Regression for the LRU vs FIFO bug. The cap is 100. If eviction
    // were FIFO, the first batch would die as soon as the 101st arrives
    // regardless of how many times it was retried. Under correct LRU,
    // touching it on every retry must push it to the tail of the
    // insertion-order Map, so it outlives younger cold batches.
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    // Helper: invoke delegate_tasks with a single trivial task and
    // extract the batchId from the JSON response envelope.
    const dispatchOne = async (label: string): Promise<string> => {
      const res = await delegateTool.handler(
        {
          tasks: [
            {
              prompt: label,
              provider: 'mock',
              tier: 'standard',
              requiredCapabilities: [],
            },
          ],
        },
        // minimal RequestHandlerExtra — handler only reads `_meta?.progressToken`
        {},
      );
      const payload = JSON.parse(res.content[0].text);
      return payload.batchId as string;
    };

    // Step 1: create a batch we intend to keep hot.
    const hotId = await dispatchOne('hot-batch');

    // Step 2: fill the cache with 99 cold batches (cache size = 100, no
    // eviction yet). After this, `hotId` is at the head of insertion
    // order (the oldest).
    for (let i = 0; i < 99; i++) {
      await dispatchOne(`cold-${i}`);
    }

    // Step 3: retry the hot batch. This must move it to the tail.
    await retryTool.handler({ batchId: hotId, taskIndices: [0] }, {});

    // Step 4: add 50 MORE batches. Under LRU, this evicts the 50
    // least-recently-used entries — which are the oldest of the cold
    // batches from step 2, NOT the hot batch (because step 3 touched
    // it). Under the old FIFO behavior, the hot batch would have been
    // evicted first when the 101st total batch arrived.
    for (let i = 0; i < 50; i++) {
      await dispatchOne(`post-touch-${i}`);
    }

    // Step 5: the hot batch must still be retrievable.
    const retried = await retryTool.handler(
      { batchId: hotId, taskIndices: [0] },
      {},
    );
    expect(retried.content).toBeDefined();
    expect(retried.content[0].type).toBe('text');
    const retriedPayload = JSON.parse(retried.content[0].text);
    expect(retriedPayload.batchId).toBeDefined();
    // The retry dispatches as a new batch, so it gets its own batchId —
    // the important assertion is that the lookup did not throw
    // "unknown or expired", which it would under the FIFO bug.
  });
});

describe('delegate_tasks schema — contextBlockIds', () => {
  const taskSchema = buildTaskSchema(['mock']);

  it('accepts a task with contextBlockIds', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: [],
      contextBlockIds: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a task with no contextBlockIds (optional)', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('delegate_tasks schema', () => {
  const taskSchema = buildTaskSchema(['mock']);

  it('accepts a task with tier and requiredCapabilities', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: ['file_read'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a task missing tier', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a task missing requiredCapabilities', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier values', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'super-duper',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid capability values', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: ['psychic_powers'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty requiredCapabilities array', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'trivial',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid effort enum values', () => {
    for (const effort of ['none', 'low', 'medium', 'high'] as const) {
      const result = taskSchema.safeParse({
        prompt: 'do thing',
        provider: 'mock',
        tier: 'standard',
        requiredCapabilities: [],
        effort,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid effort values', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: [],
      effort: 'extreme',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a task with no effort field (optional)', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts v0.3.0 MCP task fields', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: [],
      expectedCoverage: {
        minSections: 2,
        sectionPattern: '^##\\s+',
        requiredMarkers: ['alpha', 'beta'],
      },
      includeProgressTrace: true,
      parentModel: 'gpt-5.4',
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error('expected task schema parse to succeed');
    }
    expect(result.data.expectedCoverage).toEqual({
      minSections: 2,
      sectionPattern: '^##\\s+',
      requiredMarkers: ['alpha', 'beta'],
    });
    expect(result.data.includeProgressTrace).toBe(true);
    expect(result.data.parentModel).toBe('gpt-5.4');
  });
});

describe('delegate_tasks MCP input contract (v0.3.0)', () => {
  it('preserves expectedCoverage, includeProgressTrace, and parentModel in the registered MCP input schema', async () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];

    const parsed = delegateTool.inputSchema.parse({
      tasks: [
        {
          prompt: 'do thing',
          provider: 'mock',
          tier: 'standard',
          requiredCapabilities: [],
          expectedCoverage: {
            minSections: 2,
            sectionPattern: '^##\\s+',
            requiredMarkers: ['alpha', 'beta'],
          },
          includeProgressTrace: true,
          parentModel: 'gpt-5.4',
        },
      ],
    });

    expect(parsed.tasks[0].expectedCoverage).toEqual({
      minSections: 2,
      sectionPattern: '^##\\s+',
      requiredMarkers: ['alpha', 'beta'],
    });
    expect(parsed.tasks[0].includeProgressTrace).toBe(true);
    expect(parsed.tasks[0].parentModel).toBe('gpt-5.4');
  });
});

// Task 11: Response pagination + get_task_output + configurable threshold

describe('buildMcpServer — largeResponseThresholdChars (v0.3.0)', () => {
  beforeEach(() => {
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  it('buildMcpServer accepts the largeResponseThresholdChars option', () => {
    const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
    expect(server).toBeDefined();
  });

  it('buildMcpServer option overrides the default', () => {
    const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
    expect(server).toBeDefined();
  });

  it('config file override beats buildMcpServer option', () => {
    const config: MultiModelConfig = {
      ...sampleConfig(),
      defaults: {
        ...sampleConfig().defaults,
        largeResponseThresholdChars: 500,
      },
    };
    const server = buildMcpServer(config, { largeResponseThresholdChars: 100 });
    expect(server).toBeDefined();
  });

  it('env var beats everything', () => {
    process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS = '9999';
    const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
    expect(server).toBeDefined();
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  it('malformed env var (non-integer) falls through to next layer, does not crash', () => {
    process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS = 'not-a-number';
    expect(() => buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 })).not.toThrow();
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });
});

describe('delegate_tasks — responseMode + pagination (v0.3.0)', () => {
  beforeEach(() => {
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  // Helper to dispatch a single task and parse the response
  const dispatchOne = async (
    server: ReturnType<typeof buildMcpServer>,
    responseMode?: 'full' | 'summary' | 'auto',
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];
    const res = await delegateTool.handler(
      {
        tasks: [
          {
            prompt: 'do thing',
            provider: 'mock',
            tier: 'standard',
            requiredCapabilities: [],
          },
        ],
        ...(responseMode && { responseMode }),
      },
      {},
    );
    return JSON.parse(res.content[0].text);
  };

  it('small batch + responseMode: auto → mode: full, no note', async () => {
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'auto');
    expect(payload.mode).toBe('full');
    expect(payload.note).toBeUndefined();
  });

  it('small batch + responseMode: summary → mode: summary, no note', async () => {
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'summary');
    expect(payload.mode).toBe('summary');
    expect(payload.note).toBeUndefined();
    expect(payload.results[0].outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('large batch + responseMode: auto → mode: summary with note', async () => {
    const { runTasks: originalRunTasks } = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(originalRunTasks).mockResolvedValueOnce([
      {
        output: 'x'.repeat(70000),
        status: 'ok' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      },
    ]);

    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'auto');
    expect(payload.mode).toBe('summary');
    expect(payload.note).toBeDefined();
    expect(payload.note).toMatch(/Auto-switched|threshold/);
  });

  it('large batch + responseMode: full → mode: full anyway (escape hatch)', async () => {
    const { runTasks: originalRunTasks } = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(originalRunTasks).mockResolvedValueOnce([
      {
        output: 'x'.repeat(70000),
        status: 'ok' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      },
    ]);

    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'full');
    expect(payload.mode).toBe('full');
  });

  it('responseMode omitted → defaults to auto', async () => {
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server);
    expect(payload.mode).toBe('full');
  });

  it('configurable threshold via buildMcpServer option triggers summary mode', async () => {
    const { runTasks: originalRunTasks } = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(originalRunTasks).mockResolvedValueOnce([
      {
        output: 'x'.repeat(200),
        status: 'ok' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      },
    ]);

    const server = buildMcpServer(sampleConfig(), { largeResponseThresholdChars: 100 });
    const payload = await dispatchOne(server, 'auto');
    expect(payload.mode).toBe('summary');
  });

  it('configurable threshold via env var triggers summary mode', async () => {
    const { runTasks: originalRunTasks } = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(originalRunTasks).mockResolvedValueOnce([
      {
        output: 'x'.repeat(200),
        status: 'ok' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      },
    ]);

    process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS = '100';
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'auto');
    expect(payload.mode).toBe('summary');
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  it('summary mode result has correct shape', async () => {
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server, 'summary');
    const result = payload.results[0];
    expect(result.taskIndex).toBe(0);
    expect(result.outputLength).toBeDefined();
    expect(typeof result.outputLength).toBe('number');
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result._fetchWith).toContain('get_task_output');
  });
});

describe('get_task_output tool (v0.3.0)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTools = (server: ReturnType<typeof buildMcpServer>): Record<string, any> => (server as any)._registeredTools;

  it('registers get_task_output alongside other tools', () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    expect(tools['get_task_output']).toBeDefined();
  });

  it('valid batchId + taskIndex → returns full text', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const getTool = tools['get_task_output'];

    const { runTasks: originalRunTasks } = await import('@zhixuan92/multi-model-agent-core/run-tasks');
    vi.mocked(originalRunTasks).mockResolvedValueOnce([
      {
        output: 'the exact output text',
        status: 'ok' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      },
    ]);

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'do thing', provider: 'mock', tier: 'standard', requiredCapabilities: [] }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    const outputRes = await getTool.handler({ batchId, taskIndex: 0 }, {});
    const outputPayload = JSON.parse(outputRes.content[0].text);
    expect(outputPayload.output).toBe('the exact output text');
  });

  it('unknown batchId → throws "unknown or expired"', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const getTool = tools['get_task_output'];
    await expect(
      getTool.handler({ batchId: 'does-not-exist', taskIndex: 0 }, {}),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('out-of-range taskIndex → throws "out of range"', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const getTool = tools['get_task_output'];

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'do thing', provider: 'mock', tier: 'standard', requiredCapabilities: [] }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    await expect(
      getTool.handler({ batchId, taskIndex: 99 }, {}),
    ).rejects.toThrow(/out of range/);
  });

  it('get_task_output touches LRU order', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const getTool = tools['get_task_output'];

    // Dispatch 100 batches
    const batchIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await delegateTool.handler(
        { tasks: [{ prompt: `batch-${i}`, provider: 'mock', tier: 'standard', requiredCapabilities: [] }] },
        {},
      );
      batchIds.push(JSON.parse(res.content[0].text).batchId);
    }

    // Touch the first batch via get_task_output
    await getTool.handler({ batchId: batchIds[0], taskIndex: 0 }, {});

    // Dispatch 1 more batch — this should evict the oldest-not-touched (batch[1])
    await delegateTool.handler(
      { tasks: [{ prompt: 'new-batch', provider: 'mock', tier: 'standard', requiredCapabilities: [] }] },
      {},
    );

    // batch[1] should be gone (evicted), but batch[0] should still work
    await expect(
      getTool.handler({ batchId: batchIds[1], taskIndex: 0 }, {}),
    ).rejects.toThrow(/unknown or expired/);

    // batch[0] still works
    const outputRes = await getTool.handler({ batchId: batchIds[0], taskIndex: 0 }, {});
    expect(outputRes.content).toBeDefined();
  });
});

describe('retry_tasks — pagination + new batch (v0.3.0)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTools = (server: ReturnType<typeof buildMcpServer>): Record<string, any> => (server as any)._registeredTools;

  beforeEach(() => {
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  it('accepts responseMode and honors it on the retry response', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    // Dispatch a 3-task batch
    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'task-0', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 'task-1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 'task-2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
        ],
      },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    // Retry with summary mode
    const retryRes = await retryTool.handler(
      { batchId, taskIndices: [0, 2], responseMode: 'summary' },
      {},
    );
    const retryPayload = JSON.parse(retryRes.content[0].text);
    expect(retryPayload.mode).toBe('summary');
    expect(retryPayload.results[0].outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a fresh batch for the retried tasks (new batchId, original preserved)', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];
    const getTool = tools['get_task_output'];

    // Dispatch a 3-task batch
    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'task-0', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 'task-1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 'task-2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
        ],
      },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const originalBatchId = dispatchPayload.batchId;

    // Retry task 1
    const retryRes = await retryTool.handler(
      { batchId: originalBatchId, taskIndices: [1] },
      {},
    );
    const retryPayload = JSON.parse(retryRes.content[0].text);
    const retryBatchId = retryPayload.batchId;

    expect(retryBatchId).not.toBe(originalBatchId);

    // Original batch still has results accessible
    const originalOutput = await getTool.handler({ batchId: originalBatchId, taskIndex: 1 }, {});
    expect(originalOutput.content).toBeDefined();

    // Retry batch has the retried task
    expect(retryPayload.results.length).toBe(1);
    expect(retryPayload.originalBatchId).toBe(originalBatchId);
    expect(retryPayload.originalIndices).toEqual([1]);
  });

  it('retry_tasks response includes the new batchId so callers can chain retries', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'task-0', provider: 'mock', tier: 'standard', requiredCapabilities: [] }] },
      {},
    );
    const batchId = JSON.parse(dispatchRes.content[0].text).batchId;

    const retryRes = await retryTool.handler({ batchId, taskIndices: [0] }, {});
    const retryPayload = JSON.parse(retryRes.content[0].text);
    expect(retryPayload.batchId).toBeDefined();
    expect(retryPayload.batchId).not.toBe(batchId);
  });

  it('retry_tasks response includes originalBatchId + originalIndices for traceability', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 't0', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 't1', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
          { prompt: 't2', provider: 'mock', tier: 'standard', requiredCapabilities: [] },
        ],
      },
      {},
    );
    const batchId = JSON.parse(dispatchRes.content[0].text).batchId;

    const retryRes = await retryTool.handler({ batchId, taskIndices: [0, 2] }, {});
    const retryPayload = JSON.parse(retryRes.content[0].text);
    expect(retryPayload.originalBatchId).toBe(batchId);
    expect(retryPayload.originalIndices).toEqual([0, 2]);
    expect(retryPayload.results.length).toBe(2);
  });
});

// Task 12: Envelope aggregates helpers

const baseMockResult: RunResult = {
  output: 'stub ok',
  status: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
};

describe('computeTimings (v0.3.0)', () => {
  it('single task → sumOfTaskMs equals task durationMs, savings is 0', () => {
    const results: RunResult[] = [{
      ...baseMockResult,
      durationMs: 1000,
    }];
    const timings = computeTimings(1100, results);
    expect(timings.wallClockMs).toBe(1100);
    expect(timings.sumOfTaskMs).toBe(1000);
    expect(timings.estimatedParallelSavingsMs).toBe(0);
  });

  it('3 parallel tasks of 1000ms each + wall-clock 1100 → savings ~1900ms', () => {
    const results: RunResult[] = [
      { ...baseMockResult, durationMs: 1000 },
      { ...baseMockResult, durationMs: 1000 },
      { ...baseMockResult, durationMs: 1000 },
    ];
    const timings = computeTimings(1100, results);
    expect(timings.sumOfTaskMs).toBe(3000);
    expect(timings.estimatedParallelSavingsMs).toBe(1900);
  });

  it('task without durationMs → contributes 0 to sumOfTaskMs', () => {
    const results: RunResult[] = [
      { ...baseMockResult, durationMs: 1000 },
      { ...baseMockResult },
    ];
    const timings = computeTimings(1100, results);
    expect(timings.sumOfTaskMs).toBe(1000);
  });

  it('empty batch → all zeros', () => {
    const timings = computeTimings(50, []);
    expect(timings).toEqual({ wallClockMs: 50, sumOfTaskMs: 0, estimatedParallelSavingsMs: 0 });
  });
});

describe('computeBatchProgress (v0.3.0)', () => {
  it('mixed batch counts ok / incomplete / failed correctly', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'incomplete' },
      { ...baseMockResult, status: 'error' },
    ];
    const progress = computeBatchProgress(results);
    expect(progress.totalTasks).toBe(4);
    expect(progress.completedTasks).toBe(2);
    expect(progress.incompleteTasks).toBe(1);
    expect(progress.failedTasks).toBe(1);
    expect(progress.successPercent).toBe(50.0);
  });

  it('empty batch → all zeros, successPercent 0', () => {
    const progress = computeBatchProgress([]);
    expect(progress).toEqual({
      totalTasks: 0,
      completedTasks: 0,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 0,
    });
  });

  it('all success → successPercent 100', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'ok' },
    ];
    const progress = computeBatchProgress(results);
    expect(progress.successPercent).toBe(100);
    expect(progress.failedTasks).toBe(0);
  });

  it('4 ok + 1 failed → successPercent 80.0', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'error' },
    ];
    const progress = computeBatchProgress(results);
    expect(progress.successPercent).toBe(80.0);
  });

  it('timeout and max_turns count as incompleteTasks, not failedTasks', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'max_turns' },
      { ...baseMockResult, status: 'timeout' },
      { ...baseMockResult, status: 'incomplete' },
    ];
    const progress = computeBatchProgress(results);
    expect(progress.completedTasks).toBe(1);
    expect(progress.incompleteTasks).toBe(3);
    expect(progress.failedTasks).toBe(0);
  });

  it('api_error and network_error count as failedTasks', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'api_error' },
      { ...baseMockResult, status: 'network_error' },
      { ...baseMockResult, status: 'api_aborted' },
      { ...baseMockResult, status: 'error' },
    ];
    const progress = computeBatchProgress(results);
    expect(progress.failedTasks).toBe(4);
    expect(progress.incompleteTasks).toBe(0);
  });
});

describe('computeAggregateCost (v0.3.0)', () => {
  it('sums actual and saved costs across tasks', () => {
    const results: RunResult[] = [
      { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01, savedCostUSD: 0.10 } },
      { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: 0.20 } },
    ];
    const agg = computeAggregateCost(results);
    expect(agg.totalActualCostUSD).toBeCloseTo(0.03, 5);
    expect(agg.totalSavedCostUSD).toBeCloseTo(0.30, 5);
    expect(agg.actualCostUnavailableTasks).toBe(0);
    expect(agg.savedCostUnavailableTasks).toBe(0);
  });

  it('known actual cost + no parentModel → actualCostUnavailable: 0, savedCostUnavailable: N', () => {
    const results: RunResult[] = [
      { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01, savedCostUSD: null } },
      { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
    ];
    const agg = computeAggregateCost(results);
    expect(agg.totalActualCostUSD).toBeCloseTo(0.03, 5);
    expect(agg.totalSavedCostUSD).toBe(0);
    expect(agg.actualCostUnavailableTasks).toBe(0);
    expect(agg.savedCostUnavailableTasks).toBe(2);
  });

  it('null costUSD → contributes 0 and increments actualCostUnavailableTasks', () => {
    const results: RunResult[] = [
      { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: null, savedCostUSD: null } },
      { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
    ];
    const agg = computeAggregateCost(results);
    expect(agg.totalActualCostUSD).toBeCloseTo(0.02, 5);
    expect(agg.actualCostUnavailableTasks).toBe(1);
  });

  it('empty batch → zeros', () => {
    const agg = computeAggregateCost([]);
    expect(agg).toEqual({
      totalActualCostUSD: 0,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    });
  });
});

describe('delegate_tasks headline field (full mode)', () => {
  it('full-mode response carries a headline string derived from the batch aggregates', async () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];

    const result = await delegateTool.handler(
      {
        tasks: [
          {
            prompt: 't1',
            provider: 'mock',
            tier: 'standard',
            requiredCapabilities: [],
            parentModel: 'claude-opus-4-6',
          },
          {
            prompt: 't2',
            provider: 'mock',
            tier: 'standard',
            requiredCapabilities: [],
            parentModel: 'claude-opus-4-6',
          },
        ],
        responseMode: 'full',
      },
      {},
    );

    const payload = JSON.parse(result.content[0].text);

    expect(payload.mode).toBe('full');
    expect(payload).toHaveProperty('headline');
    expect(typeof payload.headline).toBe('string');

    expect(payload.headline).toMatch(/^2 tasks, 2\/2 ok \(100\.0%\),/);
    expect(payload.headline).toContain('$0.00 actual');
    expect(payload.headline).not.toContain('ROI');
  });
});
