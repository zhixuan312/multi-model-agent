import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { INITIATIVE_OPERATIONS } from '@zhixuan92/multi-model-agent-core';

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

// Task I-7: one `mma_<operation>` tool per frozen Initiative operation, added
// alongside the original seven.
const INITIATIVE_TOOL_NAMES = INITIATIVE_OPERATIONS.map((operation) => `mma_${operation}`);

describe('contract: MCP context blocks and terminal parity', () => {
  it('adds two handler-backed tools and preserves REST/MCP terminal equality', async () => {
    const harness = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'contract', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${harness.token}` } },
    }));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'mma_context_block_create', 'mma_context_block_delete', 'mma_run',
        'mma_task_cancel', 'mma_task_get', 'mma_task_list', 'mma_task_wait',
        ...INITIATIVE_TOOL_NAMES,
      ].sort());
      const created = parse(await client.callTool({ name: 'mma_context_block_create', arguments: { cwd: process.cwd(), content: 'shared' } }));
      expect(created.id).toEqual(expect.any(String));
      const run = parse(await client.callTool({ name: 'mma_run', arguments: { cwd: process.cwd(), mode: 'handle', request: { type: 'investigate', prompt: 'use context', contextBlockIds: [created.id] } } }));
      const terminal = parse(await client.callTool({ name: 'mma_task_wait', arguments: { taskId: run.taskId, timeoutMs: 30_000 } }));
      const rest = await fetch(`${harness.baseUrl}/task/${run.taskId}`, { headers: { Authorization: `Bearer ${harness.token}`, 'X-MMA-Client': 'codex', 'X-MMA-Main-Model': 'gpt-test' } });
      expect(await rest.json()).toEqual(terminal);
      expect(parse(await client.callTool({ name: 'mma_context_block_delete', arguments: { cwd: process.cwd(), blockId: created.id } }))).toEqual({ ok: true });
    } finally { await client.close(); await harness.close(); }
  });
});