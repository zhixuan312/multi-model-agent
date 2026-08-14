import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { INITIATIVE_OPERATIONS } from '@zhixuan92/multi-model-agent-core';

const parse = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

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
        'mma_execution_cancel', 'mma_execution_get', 'mma_execution_list', 'mma_execution_wait',
        ...INITIATIVE_TOOL_NAMES,
      ].sort());
      const created = parse(await client.callTool({ name: 'mma_context_block_create', arguments: { cwd: process.cwd(), content: 'shared' } }));
      expect(created.id).toEqual(expect.any(String));
      const run = parse(await client.callTool({ name: 'mma_run', arguments: { cwd: process.cwd(), mode: 'handle', request: { type: 'investigate', prompt: 'use context', contextBlockIds: [created.id] } } }));
      const terminal = parse(await client.callTool({ name: 'mma_execution_wait', arguments: { executionId: run.executionId, timeoutMs: 30_000 } }));
      const rest = await fetch(`${harness.baseUrl}/execution/${run.executionId}`, { headers: { Authorization: `Bearer ${harness.token}`, 'X-MMA-Client': 'codex', 'X-MMA-Main-Model': 'gpt-test' } });
      expect(await rest.json()).toEqual(terminal);
      expect(parse(await client.callTool({ name: 'mma_context_block_delete', arguments: { cwd: process.cwd(), blockId: created.id } }))).toEqual({ ok: true });
    } finally { await client.close(); await harness.close(); }
  });
});