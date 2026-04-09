import { describe, it, expect } from 'vitest';
import { buildMcpServer } from '../src/cli.js';

describe('buildMcpServer', () => {
  it('creates an MCP server with delegate_tasks tool', async () => {
    const config = {
      providers: {
        mock: {
          type: 'openai-compatible' as const,
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
        },
      },
      defaults: {
        maxTurns: 200,
        timeoutMs: 600000,
        tools: 'full' as const,
      },
    };

    const server = buildMcpServer(config);
    expect(server).toBeDefined();
  });

  it('throws when config has no providers', () => {
    const config = {
      providers: {},
      defaults: {
        maxTurns: 200,
        timeoutMs: 600000,
        tools: 'full' as const,
      },
    };

    expect(() => buildMcpServer(config)).toThrow(/at least one configured provider/);
  });
});
