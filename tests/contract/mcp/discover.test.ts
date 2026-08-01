import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { __setExecutionArtifactOverrideForTests } from '../../../packages/server/src/mcp/execution-artifact.js';

const discoverResult = z.object({
  serverInfo: z.object({ name: z.literal('multi-model-agent'), version: z.string() }),
  protocolVersion: z.literal('2025-11-25'),
  capabilities: z.union([
    z.object({ tools: z.object({}).strict(), extensions: z.object({}).strict() }).strict(),
    z.object({
      tools: z.object({}).strict(),
      resources: z.object({}).strict(),
      extensions: z.object({ 'io.modelcontextprotocol/ui': z.object({}).strict() }).strict(),
    }).strict(),
  ]),
}).loose();

describe('contract: MCP server/discover', () => {
  afterEach(() => { __setExecutionArtifactOverrideForTests(null); });

  it('declares the tools-only set when no real execution artifact is available (the default, unbuilt state)', async () => {
    __setExecutionArtifactOverrideForTests({ available: false, html: '<!-- unbuilt -->' });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'discover-test', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const discovered = await client.request({ method: 'server/discover', params: {} }, discoverResult);
      expect(discovered.capabilities).toEqual({ tools: {}, extensions: {} });
      expect(discovered.capabilities).toEqual(client.getServerCapabilities());
      expect(JSON.stringify(discovered)).not.toContain('resources');
      expect(JSON.stringify(discovered)).not.toContain('io.modelcontextprotocol/ui');
      // Flow 1's negative invariant survives for the unbuilt state: no handler is
      // registered, so the SDK answers method-not-found exactly as before Flow 2.
      const anyResult = z.object({}).loose();
      await expect(client.request({ method: 'resources/list', params: {} }, anyResult)).rejects.toMatchObject({ code: -32601 });
      await expect(client.request({ method: 'resources/read', params: { uri: 'mma-journal://0001' } }, anyResult)).rejects.toMatchObject({ code: -32601 });
    } finally { await client.close(); await h.close(); }
  });

  it('declares resources + the UI extension, in agreement with initialize, once a real artifact is available', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>real bundle</html>' });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'discover-test-built', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const discovered = await client.request({ method: 'server/discover', params: {} }, discoverResult);
      expect(discovered.capabilities).toEqual({ tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} } });
      expect(discovered.capabilities).toEqual(client.getServerCapabilities());
      const listed = await client.listResources();
      expect(listed.resources).toHaveLength(1);
    } finally { await client.close(); await h.close(); }
  });

  it('resolves capabilities through one deps-carried binding — no second inline literal in mcp-adapter.ts', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('packages/server/src/mcp/mcp-adapter.ts', 'utf8'));
    expect(source).not.toMatch(/capabilities:\s*\{\s*tools:/);
    expect(source.match(/deps\.capabilities/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/import[\s\S]*MCP_CAPABILITIES[\s\S]*from ['"]\.\/tool-surface\.js['"]/);
  });
});
