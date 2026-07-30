import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const discoverResult = z.object({
  serverInfo: z.object({ name: z.literal('multi-model-agent'), version: z.string() }),
  protocolVersion: z.literal('2025-11-25'),
  capabilities: z.object({ tools: z.object({}).strict(), extensions: z.object({}).strict() }).strict(),
}).loose();

describe('contract: MCP server/discover', () => {
  it('returns the initialized capability value through a Zod-validated SDK request', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'discover-test', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const discovered = await client.request({ method: 'server/discover', params: {} }, discoverResult);
      expect(discovered.capabilities).toEqual({ tools: {}, extensions: {} });
      expect(discovered.capabilities).toEqual(client.getServerCapabilities());
      expect(JSON.stringify(discovered)).not.toContain('resources');
      expect(JSON.stringify(discovered)).not.toContain('io.modelcontextprotocol/ui');
    } finally { await client.close(); await h.close(); }
  });

  // Pin the negative invariant with a real request, not prose: Flow 1 declares no
  // resources capability, so both resource methods must remain unimplemented.
  // Asserting only that discovery omits the word "resources" would still pass if
  // someone registered handlers without declaring the capability.
  it('leaves resources/list and resources/read unimplemented', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'no-resources-test', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const anyResult = z.object({}).loose();
      await expect(client.request({ method: 'resources/list', params: {} }, anyResult))
        .rejects.toMatchObject({ code: -32601 });
      await expect(client.request({ method: 'resources/read', params: { uri: 'mma-journal://0001' } }, anyResult))
        .rejects.toMatchObject({ code: -32601 });
    } finally { await client.close(); await h.close(); }
  });

  it('proves the adapter has one imported capability binding rather than duplicate literals', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('packages/server/src/mcp/mcp-adapter.ts', 'utf8'));
    expect(source.match(/MCP_CAPABILITIES/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/import[\s\S]*MCP_CAPABILITIES[\s\S]*from ['"]\.\/tool-surface\.js['"]/);
    expect(source).not.toMatch(/capabilities:\s*\{\s*tools:/);
  });
});
