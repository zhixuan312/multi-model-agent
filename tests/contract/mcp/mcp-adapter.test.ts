// Contract: the MCP adapter — a second transport over the SAME ExecutionRuntime.
// Exercised through a real SDK client against the booted HTTP server (full
// initialize handshake + JSON-RPC over streamable HTTP), not by poking
// internals. The cross-surface test is the Phase-2 exit criterion: an
// execution submitted over MCP is observable over REST with the same result.
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { TASK_TYPES } from '@zhixuan92/multi-model-agent-core';

async function mcpClient(h: HarnessHandle): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
  });
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function parseText(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('contract: MCP adapter', () => {
  it('rejects unauthenticated requests before any protocol handling', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    } finally { await h.close(); }
  });

  it('lists exactly the four tools; mma_run request schema is generated from the task union', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'mma_run', 'mma_task_cancel', 'mma_task_get', 'mma_task_wait',
      ]);

      const run = tools.find((t) => t.name === 'mma_run')!;
      const schema = run.inputSchema as {
        required: string[];
        properties: { request: { oneOf?: unknown[]; anyOf?: unknown[] } };
      };
      expect(schema.required).toEqual(['cwd', 'request']);
      // The request schema is the SAME discriminated union REST validates with:
      // one variant per task type, generated — never a hand-written copy.
      const variants = (schema.properties.request.oneOf ?? schema.properties.request.anyOf) as Array<{
        properties: { type: { const?: string; enum?: string[] } };
      }>;
      const variantTypes = variants
        .map((v) => v.properties.type.const ?? v.properties.type.enum?.[0])
        .sort();
      expect(variantTypes).toEqual([...TASK_TYPES].sort());
    } finally { await client.close(); await h.close(); }
  });

  it('mma_run (handle) → mma_task_wait terminal envelope → REST sees the SAME execution', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: {
          cwd: process.cwd(),
          request: { type: 'investigate', prompt: 'what is going on here' },
          mainModel: 'claude-opus-4-8',
        },
      }));
      expect(run.status).toBe('running');
      const taskId = run.taskId as string;
      expect(taskId).toBeTruthy();

      const terminal = parseText(await client.callTool({
        name: 'mma_task_wait',
        arguments: { taskId, timeoutMs: 30_000 },
      }));
      const task = terminal.task as { taskId: string; status: string };
      expect(task.taskId).toBe(taskId);
      expect(['done', 'done_with_concerns']).toContain(task.status);

      // mma_task_get returns the same terminal envelope.
      const got = parseText(await client.callTool({ name: 'mma_task_get', arguments: { taskId } }));
      expect(got).toEqual(terminal);

      // Cross-surface: the REST adapter serves the SAME execution — one
      // runtime, two transports, no duplicated state.
      const rest = await fetch(`${h.baseUrl}/task/${taskId}`, {
        headers: {
          'X-MMA-Main-Model': 'claude-opus-4-8',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
      });
      expect(rest.status).toBe(200);
      expect(await rest.json()).toEqual(terminal);
    } finally { await client.close(); await h.close(); }
  });

  it('mma_run validates the request against the shared union (isError + fieldErrors)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const result = await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), request: { type: 'investigate' } }, // missing required prompt
      });
      expect(result.isError).toBe(true);
      const payload = parseText(result) as { error: { code: string; fieldErrors: unknown } };
      expect(payload.error.code).toBe('invalid_request');
      expect(payload.error.fieldErrors).toBeDefined();
    } finally { await client.close(); await h.close(); }
  });

  it('mma_task_cancel drives a hanging execution to terminal cancelled', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), request: { type: 'investigate', prompt: 'hangs forever' } },
      }));
      const taskId = run.taskId as string;
      await new Promise((r) => setTimeout(r, 50));

      const cancel = parseText(await client.callTool({ name: 'mma_task_cancel', arguments: { taskId } }));
      expect(cancel).toEqual({ taskId, status: 'running', cancellationRequested: true });

      const terminal = parseText(await client.callTool({
        name: 'mma_task_wait',
        arguments: { taskId, timeoutMs: 30_000 },
      }));
      expect((terminal.task as { status: string }).status).toBe('cancelled');
      expect((terminal.error as { code: string }).code).toBe('aborted');

      // Idempotent: repeat cancel reports the terminal state.
      const again = parseText(await client.callTool({ name: 'mma_task_cancel', arguments: { taskId } }));
      expect(again).toEqual({ taskId, status: 'cancelled', alreadyTerminal: true });
    } finally { await client.close(); await h.close(); }
  });

  it('mma_task_get on an unknown id reports not_found as a tool error', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const result = await client.callTool({ name: 'mma_task_get', arguments: { taskId: 'nope' } });
      expect(result.isError).toBe(true);
      expect((parseText(result).error as { code: string }).code).toBe('not_found');
    } finally { await client.close(); await h.close(); }
  });
});
