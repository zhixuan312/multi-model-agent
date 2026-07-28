// MCP adapter — a second thin transport over the same ExecutionRuntime the
// REST adapter uses. Runs INSIDE the daemon (single runtime owner): the
// endpoint is POST /mcp on the existing HTTP listener, behind the same bearer
// auth and loopback enforcement as every other route.
//
// Stateless per the 2026-07-28 model: each request gets a fresh SDK Server +
// StreamableHTTPServerTransport (no session id), and every MMA task handle is
// an explicit identifier the client passes back on each call — exactly the
// pattern the protocol prescribes for state that spans requests.
//
// MCP wire types stay in this directory. The application layer never sees
// them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { taskInputSchema, type TaskRegistry, type TaskEntry } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import type { ExecutionStore } from '../application/execution-store.js';
import { validateCwd } from '../application/cwd-validator.js';
import {
  MCP_TOOLS,
  INLINE_AUTO_TYPES,
  INLINE_WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  WAIT_CAP_MS,
  type DeliveryMode,
  DELIVERY_MODES,
} from './tool-surface.js';

export interface McpAdapterDeps {
  runtime: ExecutionRuntime;
  taskRegistry: TaskRegistry;
  store: ExecutionStore;
  serverVersion: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
    isError: true,
  };
}

/** Same running-progress shape the REST poll returns (one contract, two wires). */
function runningSnapshot(entry: TaskEntry): Record<string, unknown> {
  const now = Date.now();
  const snapshot: Record<string, unknown> = {
    taskId: entry.taskId,
    status: 'running',
    phase: entry.phase ?? 'implementing',
    elapsedMs: now - entry.startedAt,
    startedAt: new Date(entry.startedAt).toISOString(),
  };
  if (entry.cancellationRequestedAt !== null) snapshot.cancellationRequested = true;
  if (entry.tool === 'execute_plan' && entry.totalTasks != null) snapshot.totalTasks = entry.totalTasks;
  return snapshot;
}

/** Resolve a task's current payload: terminal envelope, running snapshot, or
 *  durable-store fallback (terminal results survive restarts). */
function lookupTask(deps: McpAdapterDeps, taskId: string): ToolResult {
  const entry = deps.taskRegistry.get(taskId);
  if (entry) {
    if (deps.taskRegistry.isTerminal(taskId)) {
      return jsonResult(entry.result ?? { taskId, status: entry.state, error: null });
    }
    return jsonResult(runningSnapshot(entry));
  }
  const record = deps.store.get(taskId);
  if (record?.resultJson != null) return jsonResult(JSON.parse(record.resultJson));
  return errorResult('not_found', `Task ${taskId} not found`);
}

async function waitForTerminal(deps: McpAdapterDeps, taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!deps.taskRegistry.isTerminal(taskId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function handleRun(deps: McpAdapterDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const cwdRaw = args.cwd;
  if (typeof cwdRaw !== 'string') return errorResult('invalid_request', 'cwd (string) is required');
  const cwdCheck = validateCwd(cwdRaw);
  if (!cwdCheck.ok) return errorResult(cwdCheck.error, cwdCheck.message);

  const mode = (args.mode ?? 'auto') as DeliveryMode;
  if (!DELIVERY_MODES.includes(mode)) {
    return errorResult('invalid_request', `mode must be one of ${DELIVERY_MODES.join(', ')}`);
  }
  const mainModel = typeof args.mainModel === 'string' ? args.mainModel : null;

  const parsed = taskInputSchema.safeParse(args.request);
  if (!parsed.success) {
    return errorResult('invalid_request', 'request failed validation', {
      fieldErrors: parsed.error.flatten(),
    });
  }

  const outcome = await deps.runtime.submit(parsed.data, {
    clientName: 'mcp',
    mainModel,
    projectRoot: cwdCheck.canonicalCwd,
  });
  if (!outcome.ok) {
    const code = outcome.error.kind === 'project_reservation' ? outcome.error.code : outcome.error.kind;
    return errorResult(code, outcome.error.message);
  }
  const { taskId } = outcome;

  // Delivery: the runtime classified nothing here yet — type is the heuristic.
  // 'inline' is a preference, not a force: work that outlives the wait budget
  // is promoted to a handle rather than left to hit the client's tool timeout.
  const wantInline = mode === 'inline' || (mode === 'auto' && INLINE_AUTO_TYPES.has(parsed.data.type));
  if (wantInline) {
    await waitForTerminal(deps, taskId, INLINE_WAIT_CAP_MS);
    if (deps.taskRegistry.isTerminal(taskId)) return lookupTask(deps, taskId);
  }
  return jsonResult({
    taskId,
    status: 'running',
    poll: { tool: 'mma_task_get', taskId },
    ...(wantInline ? { note: 'task outlived the inline wait budget; poll for the result' } : {}),
  });
}

function handleCancel(deps: McpAdapterDeps, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId;
  if (typeof taskId !== 'string') return errorResult('invalid_request', 'taskId (string) is required');
  const result = deps.runtime.cancel(taskId);
  if (result.outcome === 'not_found') return errorResult('not_found', `Task ${taskId} not found`);
  if (result.outcome === 'terminal') {
    return jsonResult({ taskId, status: result.entry.state, alreadyTerminal: true });
  }
  return jsonResult({ taskId, status: 'running', cancellationRequested: true });
}

/** Build a fresh SDK server wired to the shared runtime. One per request —
 *  the protocol core is stateless; all durable state lives in the runtime. */
export function buildMcpServer(deps: McpAdapterDeps): Server {
  const server = new Server(
    { name: 'multi-model-agent', version: deps.serverVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case 'mma_run':
        return handleRun(deps, args);
      case 'mma_task_get': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') return errorResult('invalid_request', 'taskId (string) is required');
        return lookupTask(deps, taskId);
      }
      case 'mma_task_wait': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') return errorResult('invalid_request', 'taskId (string) is required');
        const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : WAIT_DEFAULT_MS;
        const timeoutMs = Math.min(Math.max(1, requested), WAIT_CAP_MS);
        await waitForTerminal(deps, taskId, timeoutMs);
        return lookupTask(deps, taskId);
      }
      case 'mma_task_cancel':
        return handleCancel(deps, args);
      default:
        return errorResult('unknown_tool', `Unknown tool: ${request.params.name}`);
    }
  });

  return server;
}

/**
 * POST /mcp — one stateless exchange per request: fresh Server + transport
 * (no session id), closed when the response ends. Registered on the existing
 * router, so bearer auth applies before this runs.
 */
export async function handleMcpRequest(
  deps: McpAdapterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
