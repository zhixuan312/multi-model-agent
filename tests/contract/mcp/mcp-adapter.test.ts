// Contract: the MCP adapter — a second transport over the SAME ExecutionRuntime.
// Exercised through a real SDK client against the booted HTTP server (full
// initialize handshake + JSON-RPC over streamable HTTP), not by poking
// internals. The cross-surface test is the Phase-2 exit criterion: an
// execution submitted over MCP is observable over REST with the same result.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, type HarnessHandle } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { TASK_TYPES, INITIATIVE_OPERATIONS, canonicalContractDigest } from '@zhixuan92/multi-model-agent-core';

/** Task I-7: one `mma_<operation>` tool per frozen Initiative operation, added
 *  alongside the original seven. Derived from the same frozen operation list
 *  the tool surface itself is built from, so this assertion tracks the real
 *  contract rather than a hand-copied name list. */
const INITIATIVE_TOOL_NAMES = INITIATIVE_OPERATIONS.map((operation) => `mma_${operation}`);

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

  it('lists the seven original tools plus one mma_<operation> per frozen Initiative operation; mma_run request schema is generated from the task union', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'mma_context_block_create', 'mma_context_block_delete', 'mma_run',
        'mma_execution_cancel', 'mma_execution_get', 'mma_execution_list', 'mma_execution_wait',
        ...INITIATIVE_TOOL_NAMES,
      ].sort());

      const run = tools.find((t) => t.name === 'mma_run')!;
      const schema = run.inputSchema as {
        required: string[];
        properties: Record<string, unknown> & { request: { oneOf?: unknown[]; anyOf?: unknown[] } };
      };
      // No `mainModel` on the wire. The cost baseline is the daemon's configured
      // `agents.main` tier, so the caller carries nothing for it.
      expect(schema.required).toEqual(['cwd', 'request']);
      expect(Object.keys(schema.properties)).not.toContain('mainModel');
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

  it('mma_run (handle) → mma_execution_wait terminal envelope → REST sees the SAME execution', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: {
          cwd: process.cwd(),
          request: { type: 'investigate', prompt: 'what is going on here' },
        },
      }));
      expect(run.status).toBe('running');
      const executionId = run.executionId as string;
      expect(executionId).toBeTruthy();

      const terminal = parseText(await client.callTool({
        name: 'mma_execution_wait',
        arguments: { executionId, timeoutMs: 30_000 },
      }));
      const execution = terminal.execution as { executionId: string; status: string };
      expect(execution.executionId).toBe(executionId);
      expect(['done', 'done_with_concerns']).toContain(execution.status);

      // mma_execution_get returns the same terminal envelope.
      const got = parseText(await client.callTool({ name: 'mma_execution_get', arguments: { executionId } }));
      expect(got).toEqual(terminal);

      // Cross-surface: the REST adapter serves the SAME execution — one
      // runtime, two transports, no duplicated state.
      const rest = await fetch(`${h.baseUrl}/execution/${executionId}`, {
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

  /**
   * The inverse of the rule that used to live here.
   *
   * `mainModel` was briefly a required argument, because the runtime otherwise
   * guessed the cost baseline from a worker tier and reported a negative saving
   * for runs that saved money. The baseline now comes from the daemon's
   * configured `agents.main` tier, so the caller carries nothing: a call with no
   * model argument is admitted and runs normally.
   *
   * An unknown extra argument is still refused — the tool schema is closed.
   */
  it('mma_run admits a call that names no model at all', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), mode: 'handle', request: { type: 'investigate', prompt: 'x' } },
      }));
      expect(run.executionId).toBeTruthy();
      expect(run.status).toBe('running');
    } finally { await client.close(); await h.close(); }
  });

  it('mma_execution_cancel drives a hanging execution to terminal cancelled', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), request: { type: 'investigate', prompt: 'hangs forever' } },
      }));
      const executionId = run.executionId as string;
      await new Promise((r) => setTimeout(r, 50));

      const cancel = parseText(await client.callTool({ name: 'mma_execution_cancel', arguments: { executionId } }));
      // Identity travels with every reference to the execution, cancel included — otherwise
      // "which one did I just cancel?" is unanswerable from the transcript.
      expect(cancel).toEqual({
        executionId, type: 'investigate', cwd: expect.any(String),
        status: 'running', cancellationRequested: true,
      });

      const terminal = parseText(await client.callTool({
        name: 'mma_execution_wait',
        arguments: { executionId, timeoutMs: 30_000 },
      }));
      expect((terminal.execution as { status: string }).status).toBe('cancelled');
      expect((terminal.error as { code: string }).code).toBe('aborted');

      // Idempotent: repeat cancel reports the terminal state.
      const again = parseText(await client.callTool({ name: 'mma_execution_cancel', arguments: { executionId } }));
      expect(again).toEqual({
        executionId, type: 'investigate', cwd: expect.any(String),
        status: 'cancelled', alreadyTerminal: true,
      });
    } finally { await client.close(); await h.close(); }
  });

  /**
   * REST could always answer "what is running?" via GET /status. Over MCP the only
   * askable question was "what is THIS id doing?", which presumes the caller still has
   * the id — so a caller that lost track of a handle had no way back to it.
   */
  it('mma_execution_list names every in-flight task by type, and filters by project', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const run = parseText(await client.callTool({
        name: 'mma_run',
        arguments: { cwd: process.cwd(), request: { type: 'investigate', prompt: 'hangs forever' } },
      }));

      const listed = parseText(await client.callTool({ name: 'mma_execution_list', arguments: {} }));
      expect(listed.count).toBe(1);
      const [execution] = listed.executions as Array<Record<string, unknown>>;
      expect(execution).toMatchObject({
        executionId: run.executionId, type: 'investigate', status: 'running', cwd: expect.any(String),
      });
      expect(execution!.elapsedMs).toEqual(expect.any(Number));

      // Filtered to a real directory with nothing running: an empty list, not an error.
      const elsewhere = parseText(await client.callTool({
        name: 'mma_execution_list', arguments: { cwd: join(process.cwd(), 'packages') },
      }));
      expect(elsewhere).toEqual({ executions: [], count: 0 });

      await client.callTool({ name: 'mma_execution_cancel', arguments: { executionId: run.executionId } });
    } finally { await client.close(); await h.close(); }
  });

  it('mma_execution_get on an unknown id reports not_found as a tool error', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = await mcpClient(h);
    try {
      const result = await client.callTool({ name: 'mma_execution_get', arguments: { executionId: 'nope' } });
      expect(result.isError).toBe(true);
      expect((parseText(result).error as { code: string }).code).toBe('not_found');
    } finally { await client.close(); await h.close(); }
  });

  /**
   * Deliverable Contract boundary (I-3) — the same disposition-feasibility rejection
   * `route-contract.test.ts` exercises over REST, exercised over MCP with the SAME
   * `deliverable-contract-validator.ts` call. Confirms the two transports report the
   * SAME field-specific detail, not two hand-maintained checks that could drift.
   */
  it('mma_run rejects disposition "pr" for a non-git cwd with a deliverable-scoped fieldError', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mma-deliverable-mcp-nongit-'));
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
    const client = await mcpClient(h);
    try {
      const contractContent = {
        kind: 'report', audience: 'board', disposition: 'pr' as const,
        artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
        acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human' as const, references: [{ kind: 'none', reason: 'Owner judgement' }] }],
      };
      const digest = canonicalContractDigest(contractContent);
      const result = await client.callTool({
        name: 'mma_run',
        arguments: {
          cwd: tmp,
          request: {
            type: 'plan', prompt: 'plan', target: { inline: 'spec' },
            deliverable: {
              state: 'approved', ...contractContent,
              contractApproval: { contractDigest: digest, approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
            },
          },
        },
      });
      expect(result.isError).toBe(true);
      const payload = parseText(result) as { error: { code: string; fieldErrors: { fieldErrors: Record<string, string[]> } } };
      expect(payload.error.code).toBe('invalid_request');
      expect(payload.error.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/requires the workspace root to be a git repository/);
    } finally { await client.close(); await h.close(); await rm(tmp, { recursive: true, force: true }); }
  });
});
