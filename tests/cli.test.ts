import { describe, it, expect } from 'vitest';
import { buildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION } from '@zhixuan92/multi-model-agent-mcp';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

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

  it('server version matches package version', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
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