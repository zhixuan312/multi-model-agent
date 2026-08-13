import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { __setExecutionArtifactOverrideForTests } from '../../../packages/server/src/mcp/execution-artifact.js';
import { INITIATIVE_OPERATIONS } from '@zhixuan92/multi-model-agent-core';

// Task I-7: one `mma_<operation>` tool per frozen Initiative operation, added
// alongside the original seven.
//
// SPEC-005 Method Registry (Task I-3, FR-10) froze `method_get`, `method_list`, and
// `initiative_task_set_method` as `mma_initiative_<operation>` rather than the mechanical
// `mma_<operation>` every other operation uses — see tool-surface.ts's own
// `INITIATIVE_TOOL_NAME_OVERRIDES`. Encoded independently here (not imported) so this
// assertion still catches a real naming regression in the tool surface.
const INITIATIVE_TOOL_NAME_OVERRIDES = new Set(['method_get', 'method_list', 'initiative_task_set_method']);
const INITIATIVE_TOOL_NAMES = INITIATIVE_OPERATIONS.map((operation) =>
  INITIATIVE_TOOL_NAME_OVERRIDES.has(operation) ? `mma_initiative_${operation}` : `mma_${operation}`,
);

async function runOnce(h: HarnessHandle): Promise<string> {
  const client = new Client({ name: 'byte-parity', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
  try {
    const result = await client.callTool({
      name: 'mma_run',
      arguments: { cwd: process.cwd(), request: { type: 'investigate', prompt: 'fixed byte-parity prompt' } },
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    // Normalize EVERY per-call-varying field. The handle payload at HEAD is
    // { executionId, type, cwd, status, poll: { mcpTool, executionId }, note? } — verified against
    // mcp-adapter.ts — so the SAME fresh id appears twice. Deleting only the
    // top-level one leaves poll.executionId differing between the two calls and the
    // assertion fails on correct, unchanged behaviour. Everything else (including
    // the identity fields and poll.mcpTool) must survive, or this stops proving parity.
    const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
    const normalized = structuredClone(parsed) as Record<string, unknown> & { poll?: Record<string, unknown> };
    delete normalized.executionId;
    if (normalized.poll) delete normalized.poll.executionId;
    return JSON.stringify(normalized);
  } finally { await client.close(); }
}

describe('contract: non-App-client byte parity', () => {
  afterEach(() => { __setExecutionArtifactOverrideForTests(null); });

  it('mma_run returns byte-identical (executionId aside) JSON whether or not the App resource is declared', async () => {
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

  it('the seven original tool names plus the Initiative tools and mma_run generated schema are unchanged regardless of capability branch', async () => {
    __setExecutionArtifactOverrideForTests({ available: true, html: '<html>real bundle</html>' });
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'schema-parity', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'mma_context_block_create', 'mma_context_block_delete', 'mma_run',
        'mma_execution_cancel', 'mma_execution_get', 'mma_execution_list', 'mma_execution_wait',
        ...INITIATIVE_TOOL_NAMES,
      ].sort());
      const run = tools.find((t) => t.name === 'mma_run')!;
      expect(run.inputSchema).toMatchObject({ required: ['cwd', 'request'], type: 'object' });
    } finally { await client.close(); await h.close(); }
  });
});