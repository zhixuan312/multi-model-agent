import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { __setExecutionArtifactOverrideForTests, getExecutionResourceUri } from '../../../packages/server/src/mcp/execution-artifact.js';

const FAKE_HTML = '<html><body>fake execution monitor</body></html>';

async function mcpClient(h: HarnessHandle) {
  const client = new Client({ name: 'resource-contract', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
  return client;
}

describe('contract: MCP execution resource', () => {
  afterEach(() => { __setExecutionArtifactOverrideForTests(null); });

  it('lists and reads the one resource when the artifact is available', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: FAKE_HTML });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toEqual([{
        uri: getExecutionResourceUri(), name: expect.any(String), description: expect.any(String),
        mimeType: 'text/html;profile=mcp-app',
      }]);
      // The bare URI must still resolve: a host that cached an older fingerprint asks for it.
      const read = await client.readResource({ uri: 'ui://mma/execution.html' });
      expect(read.contents).toEqual([{ uri: 'ui://mma/execution.html', mimeType: 'text/html;profile=mcp-app', text: FAKE_HTML }]);
    } finally { await client.close(); await h.close(); }
  });

  it('rejects a malformed or non-ui:// URI with -32602', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: FAKE_HTML });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      await expect(client.readResource({ uri: 'not-a-uri' })).rejects.toMatchObject({ code: -32602 });
      await expect(client.readResource({ uri: 'https://mma/execution.html' })).rejects.toMatchObject({ code: -32602 });
    } finally { await client.close(); await h.close(); }
  });

  it('rejects a well-formed but unknown ui:// URI with -32002, disclosing no filesystem path', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: FAKE_HTML });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const err = await client.readResource({ uri: 'ui://mma/nope.html' }).catch((e: unknown) => e);
      expect((err as { code?: number }).code).toBe(-32002);
      const message = (err as { message: string }).message;
      expect(message).not.toMatch(/packages\/server\/(dist|src)/);
      expect(message).not.toContain(process.cwd());
    } finally { await client.close(); await h.close(); }
  });

  it('serves the tools-only capability set and no resources when the artifact is unavailable', async () => {
    __setExecutionArtifactOverrideForTests({ available: false, html: '<!-- unbuilt -->' });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      expect(client.getServerCapabilities()).toEqual({ tools: {}, extensions: {} });
      const anyResult = { parse: (v: unknown) => v };
      await expect(client.request({ method: 'resources/list', params: {} }, anyResult as never)).rejects.toMatchObject({ code: -32601 });
      await expect(client.request({ method: 'resources/read', params: { uri: 'ui://mma/execution.html' } }, anyResult as never)).rejects.toMatchObject({ code: -32601 });
    } finally { await client.close(); await h.close(); }
  });

  it('only mma_run carries _meta.ui.resourceUri; the other three tools do not', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: FAKE_HTML });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const { tools } = await client.listTools();
      const run = tools.find((t) => t.name === 'mma_run')!;
      // Advertised WITH the build fingerprint, so a host cache invalidates when the bundle
      // changes. See resource-cache-busting.test.ts for why.
      expect(run._meta).toEqual({ ui: { resourceUri: getExecutionResourceUri() } });
      for (const t of tools.filter((t) => t.name !== 'mma_run')) {
        expect((t._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
      }
    } finally { await client.close(); await h.close(); }
  });
});