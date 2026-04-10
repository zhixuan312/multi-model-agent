import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION } from '@zhixuan92/multi-model-agent-mcp';
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
});