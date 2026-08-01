import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import {
  __setExecutionArtifactOverrideForTests,
  getExecutionResourceUri,
  executionResourceUriMatches,
  EXECUTION_RESOURCE_URI,
} from '../../../packages/server/src/mcp/execution-artifact.js';

/**
 * Hosts cache a UI resource by URI, and Claude Desktop caches it hard: a rebuilt bundle kept
 * being served stale across daemon restarts AND new conversations. In development that is
 * merely slow. In production it is a shipping bug — a user who upgrades mma would keep running
 * the old App indefinitely, with no signal that anything was wrong, because a fixed URI gives
 * the host nothing to invalidate on.
 *
 * The advertised URI therefore carries a fingerprint of the bytes: new bytes, new URI, cache
 * misses exactly when it should.
 */
async function mcpClient(h: HarnessHandle) {
  const client = new Client({ name: 'cache-busting', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
    })
  );
  return client;
}

describe('contract: execution App resource is content-addressed', () => {
  afterEach(() => { __setExecutionArtifactOverrideForTests(null); });

  it('changes the advertised URI when the bundle bytes change', () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>build one</html>' });
    const first = getExecutionResourceUri();
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>build two</html>' });
    const second = getExecutionResourceUri();

    expect(first).toMatch(/^ui:\/\/mma\/execution\.html\?v=[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });

  it('keeps the URI stable when the bytes are unchanged, so the cache still works', () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>same</html>' });
    const a = getExecutionResourceUri();
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>same</html>' });
    expect(getExecutionResourceUri()).toBe(a);
  });

  it('still serves a host that asks for an OLD fingerprint, or none at all', () => {
    // Refusing a stale URI would turn a stale cache into a hard failure — strictly worse,
    // since the response body is the truth either way.
    expect(executionResourceUriMatches(EXECUTION_RESOURCE_URI)).toBe(true);
    expect(executionResourceUriMatches(`${EXECUTION_RESOURCE_URI}?v=deadbeef`)).toBe(true);
    expect(executionResourceUriMatches('ui://mma/other.html?v=deadbeef')).toBe(false);
  });

  it('advertises the SAME versioned URI from tools/list and resources/list, and serves it', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>the build</html>' });
    const expected = getExecutionResourceUri();
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const tools = await client.listTools();
      const run = tools.tools.find((t) => t.name === 'mma_run');
      const ui = (run?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
      // The tool _meta is what the host actually reads to locate the App. If only
      // resources/list were versioned, the host would keep loading the cached URI forever.
      expect(ui?.resourceUri).toBe(expected);

      const listed = await client.listResources();
      expect(listed.resources[0]?.uri).toBe(expected);

      const read = await client.readResource({ uri: expected });
      expect((read.contents[0] as { text: string }).text).toBe('<html>the build</html>');
    } finally {
      await client.close();
      await h.close();
    }
  });
});
