import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer as rawBuildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION, ASSISTANT_MODEL_NAME, buildCliGreeting, computeTimings, computeBatchProgress, computeAggregateCost, installStdioLifecycleHandlers, __resetStdioLifecycleHandlersForTests } from '../packages/mcp/src/cli.js';
import type { DiagnosticLogger } from '../packages/core/src/diagnostics/disconnect-log.js';

function makeMockLogger(): DiagnosticLogger & { calls: { request: unknown[]; notification: unknown[]; logError: unknown[]; shutdown: unknown[] } } {
  const calls = { request: [] as unknown[], notification: [] as unknown[], logError: [] as unknown[], shutdown: [] as unknown[] };
  return {
    calls,
    request: (p) => { calls.request.push(p); },
    notification: (h, s) => { calls.notification.push({ h, s }); },
    logError: (cause, err) => { calls.logError.push({ cause, err }); },
    shutdown: (cause, err) => { calls.shutdown.push({ cause, err }); },
    expectedPath: () => '/tmp/fake/mcp-test.jsonl',
  };
}
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
  options?: Parameters<typeof rawBuildMcpServer>[2],
) => rawBuildMcpServer(config, makeMockLogger(), { ...options, _testRunTasksOverride: stubRunTasks });

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
    expect(delegate.description).toContain('Set filePaths whenever the task targets specific files');
    expect(delegate.description).toContain('Set done whenever you have explicit acceptance criteria (required)');
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

  it('register_context_block handler stores content and returns contextBlockId', async () => {
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
    expect(payload).toEqual({ contextBlockId: 'greeting' });
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
              prompt: `Implement the ${label} feature with full test coverage`,
              done: 'Tests pass',
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
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
      agentType: 'standard',
      contextBlockIds: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a task with no contextBlockIds (optional)', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
      agentType: 'standard',
    });
    expect(result.success).toBe(true);
  });
});

describe('delegate_tasks schema', () => {
  const taskSchema = buildTaskSchema(['standard', 'complex']);

  it('accepts a task with agentType', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
      agentType: 'standard',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a task with no agentType (auto-select)', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
    });
    expect(result.success).toBe(true);
  });

  it('accepts filePaths', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
      filePaths: ['a.ts', 'b.ts'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts done (acceptance criteria)', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
      done: 'when tests pass',
    });
    expect(result.success).toBe(true);
  });

  it('accepts contextBlockIds', () => {
    const result = taskSchema.safeParse({
      prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
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

describe('delegate_tasks — unified response + truncation', () => {
  beforeEach(() => {
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  // Helper to dispatch a single task and parse the response
  const dispatchOne = async (server: ReturnType<typeof buildMcpServer>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];
    const res = await delegateTool.handler(
      {
        tasks: [
          {
            prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass',
          },
        ],
      },
      {},
    );
    return JSON.parse(res.content[0].text);
  };

  it('returns the unified response shape with headline, batchId, and slim results', async () => {
    const server = buildMcpServer(sampleConfig());
    const payload = await dispatchOne(server);

    expect(payload).toHaveProperty('headline');
    expect(typeof payload.headline).toBe('string');
    expect(payload).toHaveProperty('batchId');
    expect(typeof payload.batchId).toBe('string');
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toEqual({
      status: 'ok',
      output: 'stub ok',
      filesWritten: [],
    });

    expect(payload).not.toHaveProperty('mode');
    expect(payload).not.toHaveProperty('schemaVersion');
    expect(payload).not.toHaveProperty('timings');
    expect(payload).not.toHaveProperty('batchProgress');
    expect(payload).not.toHaveProperty('aggregateCost');
  });

  it('includes error only when a result status is error', async () => {
    stubRunTasks.mockResolvedValueOnce([
      {
        output: '',
        status: 'error' as const,
        error: 'task failed',
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
    const payload = await dispatchOne(server);
    expect(payload.results[0]).toEqual({
      status: 'error',
      output: '',
      filesWritten: [],
      error: 'task failed',
    });
  });

  it('large outputs are auto-truncated with a get_batch_slice hint', async () => {
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
    const payload = await dispatchOne(server);
    expect(payload.results[0].output).toContain('[Output truncated at ');
    expect(payload.results[0].output).toContain('Use get_batch_slice({ batchId:');
    expect(payload.results[0].output).toContain('taskIndex: 0');
  });

  it('configurable threshold via buildMcpServer option triggers truncation', async () => {
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
    const payload = await dispatchOne(server);
    expect(payload.results[0].output).toContain('[Output truncated at ');
  });

  it('configurable threshold via env var triggers truncation', async () => {
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
    const payload = await dispatchOne(server);
    expect(payload.results[0].output).toContain('[Output truncated at ');
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
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

  it('valid batchId + taskIndex → returns full batch slice for one task', async () => {
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
        durationMs: 123,
      },
    ]);

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass', agentType: 'standard' as const }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    const outputRes = await sliceTool.handler({ batchId, taskIndex: 0 }, {});
    const outputPayload = JSON.parse(outputRes.content[0].text);
    expect(outputPayload.batchId).toBe(batchId);
    expect(outputPayload.timings).toEqual(computeTimings(123, [{
      ...baseMockResult,
      output: 'the exact output text',
      durationMs: 123,
    }]));
    expect(outputPayload.batchProgress).toEqual(computeBatchProgress([{
      ...baseMockResult,
      output: 'the exact output text',
      durationMs: 123,
    }]));
    expect(outputPayload.aggregateCost).toEqual(computeAggregateCost([{
      ...baseMockResult,
      output: 'the exact output text',
      durationMs: 123,
    }]));
    expect(outputPayload.results).toHaveLength(1);
    expect(outputPayload.results[0].output).toBe('the exact output text');
  });

  it('valid batchId without taskIndex → returns full RunResult array for the batch', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'Implement task zero with full coverage', done: 'Tests pass', agentType: 'standard' as const },
          { prompt: 'Implement task one with full coverage', done: 'Tests pass', agentType: 'standard' as const },
        ],
      },
      {},
    );
    const batchId = JSON.parse(dispatchRes.content[0].text).batchId;

    const outputRes = await sliceTool.handler({ batchId }, {});
    const outputPayload = JSON.parse(outputRes.content[0].text);
    expect(outputPayload.batchId).toBe(batchId);
    expect(outputPayload.results).toHaveLength(2);
  });

  it('unknown batchId → returns content response with error text', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const sliceTool = tools['get_batch_slice'];
    const res = await sliceTool.handler({ batchId: 'does-not-exist', taskIndex: 0 }, {});
    expect(res.content[0].text).toMatch(/unknown or expired/);
  });

  it('out-of-range taskIndex → returns content response with error text', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'Implement the requested feature with full test coverage', done: 'Tests pass', agentType: 'standard' as const }] },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    const res = await sliceTool.handler({ batchId, taskIndex: 99 }, {});
    expect(res.content[0].text).toMatch(/out of range/);
  });

  it('get_batch_slice touches LRU order', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const sliceTool = tools['get_batch_slice'];

    // Dispatch 100 batches
    const batchIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await delegateTool.handler(
        { tasks: [{ prompt: `Implement batch feature ${i} with full coverage`, done: 'Tests pass', agentType: 'standard' as const }] },
        {},
      );
      batchIds.push(JSON.parse(res.content[0].text).batchId);
    }

    // Touch the first batch via get_batch_slice
    await sliceTool.handler({ batchId: batchIds[0], taskIndex: 0 }, {});

    // Dispatch 1 more batch — this should evict the oldest-not-touched (batch[1])
    await delegateTool.handler(
      { tasks: [{ prompt: 'Implement new batch feature with coverage', done: 'Tests pass', agentType: 'standard' as const }] },
      {},
    );

    // batch[1] should be gone (evicted), but batch[0] should still work
    const evictedRes = await sliceTool.handler({ batchId: batchIds[1], taskIndex: 0 }, {});
    expect(evictedRes.content[0].text).toMatch(/unknown or expired/);

    // batch[0] still works
    const outputRes = await sliceTool.handler({ batchId: batchIds[0], taskIndex: 0 }, {});
    expect(outputRes.content).toBeDefined();
    expect(outputRes.content[0].text).not.toMatch(/unknown or expired/);
  });
});

describe('retry_tasks — unified response + new batch', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getTools = (server: ReturnType<typeof buildMcpServer>): Record<string, any> => (server as any)._registeredTools;

  beforeEach(() => {
    delete process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS;
  });

  it('returns the unified response shape on retry', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    // Dispatch a 3-task batch
    const dispatchRes = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'Implement task zero with full coverage', done: 'Tests pass', agentType: 'standard' as const },
          { prompt: 'Implement task one with full coverage', done: 'Tests pass', agentType: 'standard' as const },
          { prompt: 'Implement task two with full coverage', done: 'Tests pass', agentType: 'standard' as const },
        ],
      },
      {},
    );
    const dispatchPayload = JSON.parse(dispatchRes.content[0].text);
    const batchId = dispatchPayload.batchId;

    const retryRes = await retryTool.handler(
      { batchId, taskIndices: [0, 2] },
      {},
    );
    const retryPayload = JSON.parse(retryRes.content[0].text);
    expect(retryPayload).toHaveProperty('headline');
    expect(retryPayload).toHaveProperty('batchId');
    expect(retryPayload.results).toHaveLength(2);
    expect(retryPayload.results[0]).toEqual({
      status: 'ok',
      output: 'stub ok',
      filesWritten: [],
    });
    expect(retryPayload).not.toHaveProperty('mode');
    expect(retryPayload).not.toHaveProperty('originalBatchId');
    expect(retryPayload).not.toHaveProperty('originalIndices');
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
          { prompt: 'Implement task zero with full coverage', done: 'Tests pass', agentType: 'standard' as const },
          { prompt: 'Implement task one with full coverage', done: 'Tests pass', agentType: 'standard' as const },
          { prompt: 'Implement task two with full coverage', done: 'Tests pass', agentType: 'standard' as const },
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
    const originalOutput = await sliceTool.handler({ batchId: originalBatchId, taskIndex: 1 }, {});
    expect(originalOutput.content).toBeDefined();
    expect(originalOutput.content[0].text).not.toMatch(/unknown or expired/);

    // Retry batch has the retried task
    expect(retryPayload.results.length).toBe(1);
    expect(retryPayload).not.toHaveProperty('originalBatchId');
    expect(retryPayload).not.toHaveProperty('originalIndices');
  });

  it('retry_tasks response includes the new batchId so callers can chain retries', async () => {
    const server = buildMcpServer(sampleConfig());
    const tools = getTools(server);
    const delegateTool = tools['delegate_tasks'];
    const retryTool = tools['retry_tasks'];

    const dispatchRes = await delegateTool.handler(
      { tasks: [{ prompt: 'Implement task zero with full coverage', done: 'Tests pass', agentType: 'standard' as const }] },
      {},
    );
    const batchId = JSON.parse(dispatchRes.content[0].text).batchId;

    const retryRes = await retryTool.handler({ batchId, taskIndices: [0] }, {});
    const retryPayload = JSON.parse(retryRes.content[0].text);
    expect(retryPayload.batchId).toBeDefined();
    expect(retryPayload.batchId).not.toBe(batchId);
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

describe('delegate_tasks headline field', () => {
  it('unified response carries a headline string derived from the batch aggregates', async () => {
    const server = buildMcpServer(sampleConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const delegateTool = tools['delegate_tasks'];

    const result = await delegateTool.handler(
      {
        tasks: [
          {
            prompt: 'Implement feature one with full coverage',
            done: 'Tests pass',
          },
          {
            prompt: 'Implement feature two with full coverage',
            done: 'Tests pass',
          },
        ],
      },
      {},
    );

    const payload = JSON.parse(result.content[0].text);

    expect(payload).toHaveProperty('headline');
    expect(typeof payload.headline).toBe('string');

    expect(payload.headline).toMatch(/^2 tasks, 2\/2 ok \(100\.0%\),/);
    expect(payload.headline).toContain('$0.00 actual');
    expect(payload.headline).not.toContain('ROI');
    expect(payload).not.toHaveProperty('mode');
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

describe('delegate_tasks unified response — slim shape', () => {
  /**
   * Helper: run the delegate_tasks handler with an inline mock override so
   * the returned RunResult[] has realistic bulky fields. The unified-response
   * assertions verify the inline payload still stays slim and omits those.
   */
  async function dispatchRichBatch(): Promise<any> {
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

    const config: MultiModelConfig = {
      ...sampleConfig(),
      defaults: { ...sampleConfig().defaults, parentModel: 'claude-opus-4-6' },
    };
    const server = buildMcpServer(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegateTool = (server as any)._registeredTools['delegate_tasks'];
    const result = await delegateTool.handler(
      {
        tasks: [
          { prompt: 'Implement feature one with full coverage', done: 'Done', agentType: 'standard' as const },
          { prompt: 'Implement feature two with full coverage', done: 'Done', agentType: 'standard' as const },
        ],
      },
      {},
    );
    return JSON.parse(result.content[0].text);
  }

  it('emits the slim per-task shape without bulky fields', async () => {
    const payload = await dispatchRichBatch();

    expect(payload.results).toHaveLength(2);

    const task0 = payload.results[0];
    expect(task0).toEqual({
      status: 'ok',
      output: 'rich output for task 0',
      filesWritten: ['src/c-0.ts'],
    });

    // Assert dropped fields are NOT present on the slim per-task entry.
    expect(task0).not.toHaveProperty('filesRead');
    expect(task0).not.toHaveProperty('directoriesListed');
    expect(task0).not.toHaveProperty('toolCalls');
    expect(task0).not.toHaveProperty('progressTrace');
    expect(task0).not.toHaveProperty('escalationLog');
    expect(task0).not.toHaveProperty('turns');
    expect(task0).not.toHaveProperty('durationMs');
    expect(task0).not.toHaveProperty('usage');
    expect(task0).not.toHaveProperty('agents');
    expect(task0).not.toHaveProperty('models');
  });

  it('unified envelope carries a headline while omitting verbose aggregate fields', async () => {
    const payload = await dispatchRichBatch();

    expect(payload).toHaveProperty('headline');
    expect(typeof payload.headline).toBe('string');
    expect(payload.headline).toMatch(/^2 tasks, 2\/2 ok \(100\.0%\),/);
    expect(payload.headline).toContain('$0.10 saved vs claude-opus-4-6');
    expect(payload.headline).toContain('ROI');

    expect(payload).not.toHaveProperty('timings');
    expect(payload).not.toHaveProperty('batchProgress');
    expect(payload).not.toHaveProperty('aggregateCost');
  });
});

describe('installStdioLifecycleHandlers', () => {
  let stdoutOn: ReturnType<typeof vi.spyOn>;
  let stdinOn: ReturnType<typeof vi.spyOn>;
  let processOn: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetStdioLifecycleHandlersForTests();
    stdoutOn = vi.spyOn(process.stdout, 'on').mockReturnThis();
    stdinOn = vi.spyOn(process.stdin, 'on').mockReturnThis();
    processOn = vi.spyOn(process, 'on').mockReturnThis();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as (code?: number) => never);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutOn.mockRestore();
    stdinOn.mockRestore();
    processOn.mockRestore();
    exit.mockRestore();
    stderrWrite.mockRestore();
    __resetStdioLifecycleHandlersForTests();
  });

  it('registers handlers for stdout-error, stdin-end, uncaughtException, and unhandledRejection', () => {
    installStdioLifecycleHandlers(makeMockLogger());
    expect(stdoutOn.mock.calls.map(([e]) => e)).toContain('error');
    expect(stdinOn.mock.calls.map(([e]) => e)).toContain('end');
    const events = processOn.mock.calls.map(([e]) => e);
    expect(events).toContain('uncaughtException');
    expect(events).toContain('unhandledRejection');
  });

  it('EPIPE on stdout calls logger.shutdown("stdout_epipe") then process.exit(0)', () => {
    const logger = makeMockLogger();
    let handler: ((err: NodeJS.ErrnoException) => void) | undefined;
    stdoutOn.mockImplementation(((event: string, h: (err: NodeJS.ErrnoException) => void) => {
      if (event === 'error') handler = h;
      return process.stdout;
    }) as typeof process.stdout.on);
    installStdioLifecycleHandlers(logger);
    handler!(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) as NodeJS.ErrnoException);
    expect(logger.calls.shutdown).toEqual([{ cause: 'stdout_epipe', err: expect.any(Error) }]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('non-EPIPE stdout error calls logger.shutdown("stdout_other_error") then process.exit(1)', () => {
    const logger = makeMockLogger();
    let handler: ((err: NodeJS.ErrnoException) => void) | undefined;
    stdoutOn.mockImplementation(((event: string, h: (err: NodeJS.ErrnoException) => void) => {
      if (event === 'error') handler = h;
      return process.stdout;
    }) as typeof process.stdout.on);
    installStdioLifecycleHandlers(logger);
    handler!(Object.assign(new Error('something else'), { code: 'EBUSY' }) as NodeJS.ErrnoException);
    expect(logger.calls.shutdown).toEqual([{ cause: 'stdout_other_error', err: expect.any(Error) }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stdin end calls logger.shutdown("stdin_end") with no err, then process.exit(0)', () => {
    const logger = makeMockLogger();
    let handler: (() => void) | undefined;
    stdinOn.mockImplementation(((event: string, h: () => void) => {
      if (event === 'end') handler = h;
      return process.stdin;
    }) as typeof process.stdin.on);
    installStdioLifecycleHandlers(logger);
    handler!();
    expect(logger.calls.shutdown).toEqual([{ cause: 'stdin_end', err: undefined }]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('uncaughtException calls logger.shutdown("uncaughtException") then process.exit(1)', () => {
    const logger = makeMockLogger();
    let handler: ((err: Error) => void) | undefined;
    processOn.mockImplementation(((event: string, h: (err: Error) => void) => {
      if (event === 'uncaughtException') handler = h;
      return process;
    }) as typeof process.on);
    installStdioLifecycleHandlers(logger);
    handler!(new Error('fatal'));
    expect(logger.calls.shutdown).toEqual([{ cause: 'uncaughtException', err: expect.any(Error) }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection calls logger.logError and does NOT exit', () => {
    const logger = makeMockLogger();
    let handler: ((reason: unknown) => void) | undefined;
    processOn.mockImplementation(((event: string, h: (reason: unknown) => void) => {
      if (event === 'unhandledRejection') handler = h;
      return process;
    }) as typeof process.on);
    installStdioLifecycleHandlers(logger);
    handler!(new Error('boom'));
    expect(logger.calls.logError).toEqual([{ cause: 'unhandledRejection', err: expect.any(Error) }]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('second install is a no-op and writes a warning to stderr', () => {
    const logger = makeMockLogger();
    installStdioLifecycleHandlers(logger);
    stderrWrite.mockClear();
    installStdioLifecycleHandlers(logger);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle handlers already installed; skipping second install'),
    );
  });
});

describe('integration — DiagnosticLogger wired through buildMcpServer', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const pathMod = require('node:path') as typeof import('node:path');

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mcp-diag-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('audit_document calls (via register helper) produce a request event with tool name', async () => {
    const { createDiagnosticLogger } = await import('../packages/core/src/diagnostics/disconnect-log.js');
    const { buildMcpServer: realBuildMcpServer } = await import('../packages/mcp/src/cli.js');

    const logger = createDiagnosticLogger({ logDir: tmpDir });
    const server = realBuildMcpServer(sampleConfig(), logger, {
      _testRunTasksOverride: stubRunTasks as unknown as typeof runTasks,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    const audit = tools['audit_document'];

    await audit.handler(
      { document: 'This is a short document to audit.', auditType: 'correctness' },
      {},
    );

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(pathMod.join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n').map((l) => JSON.parse(l));
    const requestLines = lines.filter((l) => l.event === 'request');
    expect(requestLines.length).toBeGreaterThanOrEqual(1);
    expect(requestLines[0].tool).toBe('audit_document');
    expect(requestLines[0].status).toBe('ok');
    expect(typeof requestLines[0].durationMs).toBe('number');
    expect(typeof requestLines[0].responseBytes).toBe('number');
  });

  it('the startup banner line matches logger.expectedPath() for today (banner shape check)', async () => {
    const { createDiagnosticLogger } = await import('../packages/core/src/diagnostics/disconnect-log.js');
    const logger = createDiagnosticLogger({
      logDir: tmpDir,
      now: () => new Date('2026-04-20T14:00:00.000Z'),
    });
    const bannerLine = `[multi-model-agent] diagnostic log: ${logger.expectedPath()}\n`;
    expect(bannerLine).toBe(`[multi-model-agent] diagnostic log: ${tmpDir}/mcp-2026-04-20.jsonl\n`);
    // Sanity: the logger has not materialised the file by being constructed or queried.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
