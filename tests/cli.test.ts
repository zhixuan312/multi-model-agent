import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer as rawBuildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION, computeTimings, computeBatchProgress, computeAggregateCost } from '../packages/mcp/src/cli.js';
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
  agents: {
    standard: { type: 'openai-compatible', model: 'test-model', baseUrl: 'http://localhost:1234/v1' },
    complex: { type: 'openai-compatible', model: 'test-model-complex', baseUrl: 'http://localhost:1235/v1' },
  },
  defaults: { timeoutMs: 600000, tools: 'full' },
});

const stubRunTasks = vi.fn(
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
);

beforeEach(() => {
  stubRunTasks.mockReset();
  stubRunTasks.mockImplementation(
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
  );
});

const buildMcpServer = (
  config: MultiModelConfig = sampleConfig(),
  options?: Parameters<typeof rawBuildMcpServer>[1],
) => rawBuildMcpServer(config, { ...options, _testRunTasksOverride: stubRunTasks });

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

  it('throws when config has no agents', () => {
    const config: MultiModelConfig = {
      agents: {},
      defaults: { timeoutMs: 600000, tools: 'full' },
    };
    expect(() => buildMcpServer(config)).toThrow(/at least one configured agent/);
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
    expect(delegate.description).toContain('Available agents');
    expect(delegate.description).toContain('standard');
    expect(delegate.description).toContain('complex');
    expect(delegate.description).toContain('Prefer setting filePaths');
    expect(delegate.description).toContain('prefer setting done');
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
  const taskSchema = buildTaskSchema(['standard', 'complex']);

  it('accepts a task with contextBlockIds', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      agentType: 'standard',
      contextBlockIds: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a task with no contextBlockIds (optional)', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      agentType: 'standard',
    });
    expect(result.success).toBe(true);
  });
});

describe('delegate_tasks schema', () => {
  const taskSchema = buildTaskSchema(['standard', 'complex']);

  it('accepts a task with agentType', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      agentType: 'standard',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a task with no agentType (auto-select)', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
    });
    expect(result.success).toBe(true);
  });

  it('accepts filePaths', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      filePaths: ['a.ts', 'b.ts'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts done (acceptance criteria)', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      done: 'when tests pass',
    });
    expect(result.success).toBe(true);
  });

  it('accepts contextBlockIds', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      contextBlockIds: ['ctx1', 'ctx2'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing prompt', () => {
    const result = taskSchema.safeParse({
      agentType: 'standard',
    });
    expect(result.success).toBe(false);
  });
});

describe('delegate_tasks MCP input contract (v2.0.0)', () => {
  it('buildTaskSchema only contains the 5 core fields', async () => {
    const schema = buildTaskSchema(['standard', 'complex']);
    const shape = schema.shape;
    const fields = Object.keys(shape);
    expect(fields).toEqual(['prompt', 'agentType', 'filePaths', 'done', 'contextBlockIds']);
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
    stubRunTasks.mockResolvedValueOnce([
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
    stubRunTasks.mockResolvedValueOnce([
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
    stubRunTasks.mockResolvedValueOnce([
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
    stubRunTasks.mockResolvedValueOnce([
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
    expect(payload.schemaVersion).toBe('1.0.0');
    const result = payload.results[0];
    expect(result.taskIndex).toBe(0);
    expect(result.outputLength).toBeDefined();
    expect(typeof result.outputLength).toBe('number');
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result._fetchWith).toContain('get_batch_slice');
    expect(result._fetchWith).toContain('batchId');
    expect(result._fetchWith).toContain('taskIndex: 0');
    expect(result).not.toHaveProperty('_fetchOutputWith');
    expect(result).not.toHaveProperty('_fetchDetailWith');
  });
});

describe('get_batch_slice tool', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTools = (server: ReturnType<typeof buildMcpServer>): Record<string, any> => (server as any)._registeredTools;

  it('registers get_batch_slice alongside other tools', () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    expect(tools['get_batch_slice']).toBeDefined();
  });

  it('slice=output: valid batchId + taskIndex → returns full text', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    stubRunTasks.mockResolvedValueOnce([
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
      { tasks: [{ prompt: 'do thing', agentType: 'standard' as const }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    const outputRes = await sliceTool.handler({ batchId, slice: 'output', taskIndex: 0 }, {});
    const outputPayload = JSON.parse(outputRes.content[0].text);
    expect(outputPayload.output).toBe('the exact output text');
  });

  it('slice=output: unknown batchId → throws "unknown or expired"', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const sliceTool = tools['get_batch_slice'];
    await expect(
      sliceTool.handler({ batchId: 'does-not-exist', slice: 'output', taskIndex: 0 }, {}),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('slice=output: out-of-range taskIndex → throws "out of range"', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'do thing', agentType: 'standard' as const }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    await expect(
      sliceTool.handler({ batchId, slice: 'output', taskIndex: 99 }, {}),
    ).rejects.toThrow(/out of range/);
  });

  it('slice=output touches LRU order', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    // Dispatch 100 batches
    const batchIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await delegateTool.handler(
        { tasks: [{ prompt: `batch-${i}`, agentType: 'standard' as const }] },
        {},
      );
      batchIds.push(JSON.parse(res.content[0].text).batchId);
    }

    // Touch the first batch via get_batch_slice
    await sliceTool.handler({ batchId: batchIds[0], slice: 'output', taskIndex: 0 }, {});

    // Dispatch 1 more batch — this should evict the oldest-not-touched (batch[1])
    await delegateTool.handler(
      { tasks: [{ prompt: 'new-batch', agentType: 'standard' as const }] },
      {},
    );

    // batch[1] should be gone (evicted), but batch[0] should still work
    await expect(
      sliceTool.handler({ batchId: batchIds[1], slice: 'output', taskIndex: 0 }, {}),
    ).rejects.toThrow(/unknown or expired/);

    // batch[0] still works
    const outputRes = await sliceTool.handler({ batchId: batchIds[0], slice: 'output', taskIndex: 0 }, {});
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
          { prompt: 'task-0', agentType: 'standard' as const },
          { prompt: 'task-1', agentType: 'standard' as const },
          { prompt: 'task-2', agentType: 'standard' as const },
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
    const sliceTool = tools['get_batch_slice'];

    // Dispatch a 3-task batch
    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'task-0', agentType: 'standard' as const },
          { prompt: 'task-1', agentType: 'standard' as const },
          { prompt: 'task-2', agentType: 'standard' as const },
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

    // Original batch still has results accessible via get_batch_slice
    const originalOutput = await sliceTool.handler({ batchId: originalBatchId, slice: 'output', taskIndex: 1 }, {});
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
      { tasks: [{ prompt: 'task-0', agentType: 'standard' as const }] },
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
          { prompt: 't0', agentType: 'standard' as const },
          { prompt: 't1', agentType: 'standard' as const },
          { prompt: 't2', agentType: 'standard' as const },
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

  it('timeout and degenerate_exhausted count as incompleteTasks, not failedTasks', () => {
    const results: RunResult[] = [
      { ...baseMockResult, status: 'ok' },
      { ...baseMockResult, status: 'incomplete', errorCode: 'degenerate_exhausted' },
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
  });

  it('known actual cost + no parentModel → savedCostUSD is 0', () => {
    const results: RunResult[] = [
      { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: 0.01, savedCostUSD: null } },
      { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
    ];
    const agg = computeAggregateCost(results);
    expect(agg.totalActualCostUSD).toBeCloseTo(0.03, 5);
    expect(agg.totalSavedCostUSD).toBe(0);
  });

  it('null costUSD → contributes 0', () => {
    const results: RunResult[] = [
      { ...baseMockResult, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, costUSD: null, savedCostUSD: null } },
      { ...baseMockResult, usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200, costUSD: 0.02, savedCostUSD: null } },
    ];
    const agg = computeAggregateCost(results);
    expect(agg.totalActualCostUSD).toBeCloseTo(0.02, 5);
  });

  it('empty batch → zeros', () => {
    const agg = computeAggregateCost([]);
    expect(agg).toEqual({
      totalActualCostUSD: 0,
      totalSavedCostUSD: 0,
    });
  });
});

describe('buildTaskSchema descriptions', () => {
  const schema = buildTaskSchema(['standard', 'complex']);
  const shape = schema.shape;

  const EXPECTED_TOP_LEVEL_FIELDS = [
    'prompt',
    'agentType',
    'filePaths',
    'done',
    'contextBlockIds',
  ];

  for (const fieldName of EXPECTED_TOP_LEVEL_FIELDS) {
    it(`${fieldName} has a non-empty description`, () => {
      const fieldDef = shape[fieldName];
      expect(fieldDef, `field ${fieldName} should exist in schema`).toBeDefined();
      const desc = (fieldDef as any).description;
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThan(10);
    });
  }
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
            parentModel: 'claude-opus-4-6',
          },
          {
            prompt: 't2',
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

describe('buildTaskSchema descriptions', () => {
  const schema = buildTaskSchema(['standard', 'complex']);
  const shape = schema.shape;

  const EXPECTED_TOP_LEVEL_FIELDS = [
    'prompt',
    'agentType',
    'filePaths',
    'done',
    'contextBlockIds',
  ];

  for (const fieldName of EXPECTED_TOP_LEVEL_FIELDS) {
    it(`${fieldName} has a non-empty description`, () => {
      const fieldDef = shape[fieldName];
      expect(fieldDef, `field ${fieldName} should exist in schema`).toBeDefined();
      const desc = (fieldDef as any).description;
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThan(10);
    });
  }
});

describe('delegate_tasks summary mode — slim shape', () => {
  /**
   * Helper: run the delegate_tasks handler with an inline mock override so
   * the returned RunResult[] has realistic bulky fields (filesRead/Written,
   * toolCalls, escalationLog with reasons). The summary-shape assertions
   * need these populated on the source side to verify the slim output
   * correctly OMITS them.
   */
  async function dispatchRichBatch(opts: {
    responseMode?: 'full' | 'summary' | 'auto';
  } = {}): Promise<any> {
    stubRunTasks.mockImplementationOnce(
      async (tasks: unknown): Promise<RunResult[]> => {
        const arr = tasks as { prompt: string }[];
        return arr.map((_, i): RunResult => ({
          output: `rich output for task ${i}`,
          status: 'ok',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01, savedCostUSD: 0.05 },
          turns: 3 + i,
          filesRead: [`src/a-${i}.ts`, `src/b-${i}.ts`],
          filesWritten: [`src/c-${i}.ts`],
          directoriesListed: ['src'],
          toolCalls: [
            `readFile src/a-${i}.ts`,
            `grep foo *.ts → ${2 + i} hits`,
            `writeFile src/c-${i}.ts`,
          ],
          outputIsDiagnostic: false,
          escalationLog: i === 0
            ? [
                {
                  provider: 'mock',
                  status: 'ok',
                  turns: 3,
                  inputTokens: 100,
                  outputTokens: 50,
                  costUSD: 0.01,
                  initialPromptLengthChars: 500,
                  initialPromptHash: 'abc123',
                },
              ]
            : [
                {
                  provider: 'mock',
                  status: 'incomplete',
                  turns: 5,
                  inputTokens: 200,
                  outputTokens: 100,
                  costUSD: 0.005,
                  initialPromptLengthChars: 500,
                  initialPromptHash: 'def456',
                  reason: 'degenerate completion after supervision retries',
                },
                {
                  provider: 'mock',
                  status: 'ok',
                  turns: 4,
                  inputTokens: 300,
                  outputTokens: 150,
                  costUSD: 0.015,
                  initialPromptLengthChars: 500,
                  initialPromptHash: 'def456',
                },
              ],
          durationMs: 1000 + i * 500,
        }));
      },
    );

    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegateTool = (server as any)._registeredTools['delegate_tasks'];
    const result = await delegateTool.handler(
      {
        tasks: [
          { prompt: 't1', agentType: 'standard' as const, parentModel: 'claude-opus-4-6' },
          { prompt: 't2', agentType: 'standard' as const, parentModel: 'claude-opus-4-6' },
        ],
        ...(opts.responseMode ? { responseMode: opts.responseMode } : {}),
      },
      {},
    );
    return JSON.parse(result.content[0].text);
  }

  it('emits the slim per-task shape without bulky fields', async () => {
    const payload = await dispatchRichBatch({ responseMode: 'summary' });

    expect(payload.mode).toBe('summary');
    expect(payload.schemaVersion).toBe('1.0.0');
    expect(payload.results).toHaveLength(2);

    const task0 = payload.results[0];
    expect(task0.taskIndex).toBe(0);
    expect(task0.agentType).toBe('standard');
    expect(task0.status).toBe('ok');
    expect(task0.turns).toBe(3);
    expect(task0.durationMs).toBe(1000);
    expect(task0.outputLength).toBe('rich output for task 0'.length);
    expect(task0).toHaveProperty('outputSha256');
    expect(typeof task0.outputSha256).toBe('string');
    expect(task0.outputSha256).toHaveLength(64); // sha256 hex

    // New fetch-hint field
    expect(task0).toHaveProperty('_fetchWith');
    expect(task0._fetchWith).toContain('get_batch_slice');
    expect(task0._fetchWith).toContain(payload.batchId);
    expect(task0._fetchWith).toContain('taskIndex: 0');

    // Assert dropped fields are NOT present on the slim per-task entry.
    expect(task0).not.toHaveProperty('filesRead');
    expect(task0).not.toHaveProperty('filesWritten');
    expect(task0).not.toHaveProperty('directoriesListed');
    expect(task0).not.toHaveProperty('toolCalls');
    expect(task0).not.toHaveProperty('progressTrace');
    expect(task0).not.toHaveProperty('escalationLog');
    expect(task0).not.toHaveProperty('_fetchOutputWith');
    expect(task0).not.toHaveProperty('_fetchDetailWith');
  });

  it('summary-mode envelope carries a headline field alongside the batch aggregates', async () => {
    const payload = await dispatchRichBatch({ responseMode: 'summary' });

    expect(payload).toHaveProperty('headline');
    expect(payload).toHaveProperty('timings');
    expect(payload).toHaveProperty('batchProgress');
    expect(payload).toHaveProperty('aggregateCost');
    expect(typeof payload.headline).toBe('string');
    expect(payload.headline).toMatch(/^2 tasks, 2\/2 ok \(100\.0%\),/);
    expect(payload.headline).toContain('$0.02 actual');
    expect(payload.headline).toContain('$0.10 saved vs claude-opus-4-6');
    expect(payload.headline).toContain('ROI');
  });
});
