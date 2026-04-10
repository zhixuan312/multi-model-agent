import { describe, it, expect } from 'vitest';
import { buildMcpServer, buildTaskSchema, SERVER_NAME, SERVER_VERSION } from '@scope/multi-model-agent-mcp';
import type { MultiModelConfig } from '@scope/multi-model-agent-core';

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