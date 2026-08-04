import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { __setExecutionArtifactOverrideForTests } from '../../../packages/server/src/mcp/execution-artifact.js';

async function runOnce(h: HarnessHandle): Promise<string> {
  const client = new Client({ name: 'byte-parity', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
  try {
    const result = await client.callTool({
      name: 'mma_run',
      arguments: { cwd: process.cwd(), request: { type: 'investigate', prompt: 'fixed byte-parity prompt' }, mainModel: 'claude-opus-4-8' },
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    // Normalize EVERY per-call-varying field. The handle payload at HEAD is
    // { taskId, type, cwd, status, poll: { mcpTool, taskId }, note? } — verified against
    // mcp-adapter.ts — so the SAME fresh id appears twice. Deleting only the
    // top-level one leaves poll.taskId differing between the two calls and the
    // assertion fails on correct, unchanged behaviour. Everything else (including
    // the identity fields and poll.mcpTool) must survive, or this stops proving parity.
    const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
    const normalized = structuredClone(parsed) as Record<string, unknown> & { poll?: Record<string, unknown> };
    delete normalized.taskId;
    if (normalized.poll) delete normalized.poll.taskId;
    return JSON.stringify(normalized);
  } finally { await client.close(); }
}

describe('contract: non-App-client byte parity', () => {
  afterEach(() => { __setExecutionArtifactOverrideForTests(null); });

  it('mma_run returns byte-identical (taskId aside) JSON whether or not the App resource is declared', async () => {
    __setExecutionArtifactOverrideForTests({ available: false, html: '<!-- unbuilt -->' });
    const withoutApp = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const withoutAppJson = await runOnce(withoutApp);
    await withoutApp.close();

    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>real bundle</html>' });
    const withApp = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const withAppJson = await runOnce(withApp);
    await withApp.close();

    expect(withAppJson).toBe(withoutAppJson);
  });

  it('the five tool names and mma_run generated schema are unchanged regardless of capability branch', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>real bundle</html>' });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'schema-parity', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['mma_run', 'mma_task_cancel', 'mma_task_get', 'mma_task_list', 'mma_task_wait']);
      const run = tools.find((t) => t.name === 'mma_run')!;
      expect(run.inputSchema).toMatchObject({ required: ['cwd', 'request'], type: 'object' });
    } finally { await client.close(); await h.close(); }
  });
});