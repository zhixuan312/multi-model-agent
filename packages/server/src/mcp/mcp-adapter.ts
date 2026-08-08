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
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { taskInputSchema, type TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import type { ExecutionStore } from '../application/execution-store.js';
import type { ProjectRegistry } from '../application/project-registry.js';
import { validateCwd } from '../application/cwd-validator.js';
import { taskIdentity, buildRunningSnapshot } from '../application/task-identity.js';
import { createContextBlock, deleteContextBlock } from '../http/handlers/control/context-blocks.js';
import { resolveCallerIdentity } from '../http/middleware/caller-identity.js';
import {
  MCP_TOOLS,
  MCP_PROTOCOL_VERSION,
  INLINE_AUTO_TYPES,
  INLINE_WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  WAIT_CAP_MS,
  type DeliveryMode,
  type McpCapabilities,
  DELIVERY_MODES,
} from './tool-surface.js';
import {
  getExecutionArtifact,
  EXECUTION_RESOURCE_URI,
  getExecutionResourceUri,
  executionResourceUriMatches,
  EXECUTION_RESOURCE_MIME_TYPE,
  RESOURCE_NOT_FOUND,
} from './execution-artifact.js';

/** `server/discover` request shape — hand-rolled because SDK 1.30.0 defines none.
 *  Params may be omitted entirely or carry unknown keys. */
const DiscoverRequestSchema = z.object({
  method: z.literal('server/discover'),
  params: z.optional(z.object({}).loose()),
});

export interface McpAdapterDeps {
  runtime: ExecutionRuntime;
  taskRegistry: TaskRegistry;
  store: ExecutionStore;
  serverVersion: string;
  /** Resolved ONCE at daemon start (see `http/server.ts`); read here for both the
   *  `Server` constructor and the `server/discover` handler so they cannot disagree. */
  capabilities: McpCapabilities;
  /** Shared with the REST control handlers (`handlers/control/context-blocks.ts`) — the
   *  `mma_context_block_*` tools call the SAME `createContextBlock` / `deleteContextBlock`
   *  operations those handlers wrap, against this same registry. */
  projectRegistry: ProjectRegistry;
  maxContextBlockBytes: number;
  maxContextBlocksPerProject: number;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Attribute the execution to the CLIENT, not to the transport.
 *
 * MCP is a transport that any client can speak — Claude Code, Codex CLI, an
 * IDE, a script — so recording a flat `mcp` would erase which one it was and
 * make telemetry useless for the one question it exists to answer. The
 * 2026-07-28 protocol carries `io.modelcontextprotocol/clientInfo` in every
 * request's `_meta`, so use it when present. Older clients (Claude Code
 * currently negotiates 2025-06-18, which sends clientInfo only at initialize,
 * and this adapter is stateless per request) fall back to what the install
 * declared in `X-MMA-Client`, and only then to `mcp`.
 *
 * The value rides into the wire record's `client` column, which accepts any
 * STRICT_ID_REGEX string — no allowlist to extend.
 */
export function callerClientFromMeta(
  meta: Record<string, unknown> | undefined,
  declaredClient?: string,
): string {
  const info = meta?.['io.modelcontextprotocol/clientInfo'] as { name?: unknown } | undefined;
  const name = typeof info?.name === 'string' ? info.name.trim().toLowerCase() : '';
  if (!name) {
    // No clientInfo. Before falling back to the anonymous `mcp`, honour what the
    // install DECLARED in `X-MMA-Client` — the stdio bridge sends it when started
    // with `--client`, which is the only signal that an Agent Plugins package (or
    // Claude Desktop) is what reached us. Bare `mcp` answers no question at all,
    // and "is the standard carrying traffic yet?" is exactly the question that
    // decides whether a bespoke registration writer can be retired.
    return declaredClient && declaredClient.length > 0 ? declaredClient : 'mcp';
  }
  // clientInfo wins when present: `mcp:cursor` is strictly more informative than
  // the packaging the install came from, and newer protocol revisions send it on
  // every request.
  const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? `mcp:${slug}` : 'mcp';
}

function errorResult(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
    isError: true,
  };
}

/** Resolve a task's current payload: terminal envelope, running snapshot, or
 *  durable-store fallback (terminal results survive restarts). */
function lookupTask(deps: McpAdapterDeps, taskId: string): ToolResult {
  const entry = deps.taskRegistry.get(taskId);
  if (entry) {
    if (deps.taskRegistry.isTerminal(taskId)) {
      // The result envelope already names itself via `task.type`; the bare fallback
      // (a terminal entry with no stored result) has to be told who it is.
      return jsonResult(entry.result ?? { ...taskIdentity(entry), status: entry.state, error: null });
    }
    return jsonResult(buildRunningSnapshot(entry));
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

async function handleRun(deps: McpAdapterDeps, args: Record<string, unknown>, clientName: string): Promise<ToolResult> {
  const cwdRaw = args.cwd;
  if (typeof cwdRaw !== 'string') return errorResult('invalid_request', 'cwd (string) is required');
  const cwdCheck = validateCwd(cwdRaw);
  if (!cwdCheck.ok) return errorResult(cwdCheck.error, cwdCheck.message);

  const mode = (args.mode ?? 'auto') as DeliveryMode;
  if (!DELIVERY_MODES.includes(mode)) {
    return errorResult('invalid_request', `mode must be one of ${DELIVERY_MODES.join(', ')}`);
  }

  const parsed = taskInputSchema.safeParse(args.request);
  if (!parsed.success) {
    return errorResult('invalid_request', 'request failed validation', {
      fieldErrors: parsed.error.flatten(),
    });
  }

  const outcome = await deps.runtime.submit(parsed.data, {
    clientName,
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
  // The handle names the work it stands for. A bare `{ taskId }` forces the caller to
  // remember which of several in-flight dispatches a UUID belongs to — and an agent
  // re-reading its own transcript has only this line to go on.
  const entry = deps.taskRegistry.get(taskId);
  return jsonResult({
    ...(entry ? taskIdentity(entry) : { taskId, type: parsed.data.type }),
    status: 'running',
    // `mcpTool`, not `tool`: `tool` is what the registry calls the TASK type, and two
    // different meanings under one key is exactly the confusion this change removes.
    poll: { mcpTool: 'mma_task_get', taskId },
    ...(wantInline ? { note: 'task outlived the inline wait budget; poll for the result' } : {}),
  });
}

function handleCancel(deps: McpAdapterDeps, args: Record<string, unknown>): ToolResult {
  const taskId = args.taskId;
  if (typeof taskId !== 'string') return errorResult('invalid_request', 'taskId (string) is required');
  const result = deps.runtime.cancel(taskId);
  if (result.outcome === 'not_found') return errorResult('not_found', `Task ${taskId} not found`);
  if (result.outcome === 'terminal') {
    return jsonResult({ ...taskIdentity(result.entry), status: result.entry.state, alreadyTerminal: true });
  }
  return jsonResult({ ...taskIdentity(result.entry), status: 'running', cancellationRequested: true });
}

/**
 * Every task currently in flight, newest last.
 *
 * REST has always been able to answer this — `GET /status` returns the same entries — but
 * over MCP the only question askable was "what is THIS id doing?", which presumes the
 * caller still has the id. A caller that lost track of a handle, or that wants to know
 * what else is competing for the same project, had no way to ask.
 *
 * Optionally narrowed to one project: on a multi-repo workspace the useful question is
 * "what is running in THIS repo", not "what is running anywhere on the machine".
 */
function handleList(deps: McpAdapterDeps, args: Record<string, unknown>): ToolResult {
  const cwdRaw = args.cwd;
  let filter: string | null = null;
  if (typeof cwdRaw === 'string') {
    const check = validateCwd(cwdRaw);
    if (!check.ok) return errorResult(check.error, check.message);
    filter = check.canonicalCwd;
  }
  const now = Date.now();
  const tasks = deps.taskRegistry.allInFlight()
    .filter((entry) => filter === null || entry.cwd === filter)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((entry) => buildRunningSnapshot(entry, now));
  return jsonResult({ tasks, count: tasks.length });
}

/**
 * mma_context_block_create — validates `cwd` exactly like `handleRun` does (MCP
 * requests carry no cwd of their own), then delegates to the SAME
 * `createContextBlock` operation the REST `POST /context-blocks` handler wraps
 * (`handlers/control/context-blocks.ts`). No body validation, byte-limit, or
 * cap logic lives here — only argument shuffling and error-shape translation
 * from the operation's discriminated result to an MCP tool error.
 */
function handleContextBlockCreate(deps: McpAdapterDeps, args: Record<string, unknown>): ToolResult {
  const cwdRaw = args.cwd;
  if (typeof cwdRaw !== 'string') return errorResult('invalid_request', 'cwd (string) is required');
  const cwdCheck = validateCwd(cwdRaw);
  if (!cwdCheck.ok) return errorResult(cwdCheck.error, cwdCheck.message);
  const result = createContextBlock(
    { projectRegistry: deps.projectRegistry, maxContextBlockBytes: deps.maxContextBlockBytes, maxContextBlocksPerProject: deps.maxContextBlocksPerProject },
    { cwd: cwdCheck.canonicalCwd, content: args.content, ttlMs: args.ttlMs },
  );
  if (!result.ok) return errorResult(result.code, result.message, result.extra);
  return jsonResult({ id: result.id });
}

/**
 * mma_context_block_delete — same cwd-validation convention as
 * `handleContextBlockCreate` above, then delegates to the SAME
 * `deleteContextBlock` operation the REST `DELETE /context-blocks/:blockId`
 * handler wraps.
 */
function handleContextBlockDelete(deps: McpAdapterDeps, args: Record<string, unknown>): ToolResult {
  const cwdRaw = args.cwd;
  if (typeof cwdRaw !== 'string') return errorResult('invalid_request', 'cwd (string) is required');
  const cwdCheck = validateCwd(cwdRaw);
  if (!cwdCheck.ok) return errorResult(cwdCheck.error, cwdCheck.message);
  const blockId = args.blockId;
  if (typeof blockId !== 'string') return errorResult('invalid_request', 'blockId (string) is required');
  const result = deleteContextBlock({ projectRegistry: deps.projectRegistry }, { cwd: cwdCheck.canonicalCwd, blockId });
  if (!result.ok) return errorResult(result.code, result.message, result.extra);
  return jsonResult({ ok: true });
}

/** Build a fresh SDK server wired to the shared runtime. One per request —
 *  the protocol core is stateless; all durable state lives in the runtime. */
export function buildMcpServer(deps: McpAdapterDeps, declaredClient?: string): Server {
  const serverInfo = { name: 'multi-model-agent', version: deps.serverVersion };
  const server = new Server(serverInfo, { capabilities: deps.capabilities });

  // Stamp the CURRENT build fingerprint onto the advertised App URI at request time rather
  // than baking it into the MCP_TOOLS literal. The tool table is module-scope and the artifact
  // can be swapped underneath it (test overrides, and a rebuilt bundle on the next daemon
  // start), so a baked URI would advertise a fingerprint that no longer matches the bytes —
  // reintroducing the stale-cache bug it exists to prevent, in a form that is harder to see.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => {
      const ui = tool._meta?.['ui'] as { resourceUri?: string } | undefined;
      if (ui?.resourceUri !== EXECUTION_RESOURCE_URI) return tool;
      return { ...tool, _meta: { ...tool._meta, ui: { ...ui, resourceUri: getExecutionResourceUri() } } };
    }),
  }));

  // `server/discover` — the 2026-07-28 stateless capability-discovery method. The SDK
  // ships no schema for it (grep `Discover` across its types: nothing), so the request
  // shape is declared locally, consistent with MCP wire types never leaving this
  // directory.
  //
  // This adapter is ALREADY stateless per request — a fresh Server per POST, no session
  // id — so it redundantly re-runs `initialize` on every call. That is precisely the
  // topology `server/discover` exists to serve.
  //
  // Both this response and the constructor above read the SAME deps.capabilities
  // binding, so discovery cannot drift from initialize.
  server.setRequestHandler(DiscoverRequestSchema, async () => ({
    serverInfo,
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: deps.capabilities,
  }));

  // Resource handlers are registered ONLY when the resolved capabilities include
  // `resources` — with no real execution-app bundle, no handler is registered at all,
  // so the SDK's own method-not-found honestly reproduces the pre-Flow-2 behaviour
  // (rather than a hand-rolled -32601 special case).
  if ('resources' in deps.capabilities) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [{
          uri: getExecutionResourceUri(),
          name: 'MMA execution monitor',
          description: 'Live view of a running MMA task: phase, elapsed time, cancel control.',
          mimeType: EXECUTION_RESOURCE_MIME_TYPE,
        }],
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, 'resources/read: uri must be a well-formed ui:// URI');
      }
      if (parsed.protocol !== 'ui:' || !uri.startsWith('ui://')) {
        throw new McpError(ErrorCode.InvalidParams, 'resources/read: uri must be a well-formed ui:// URI');
      }
      if (!executionResourceUriMatches(uri)) {
        throw new McpError(RESOURCE_NOT_FOUND, 'resources/read: no resource is served at this uri');
      }
      const artifact = getExecutionArtifact();
      return {
        contents: [{ uri, mimeType: EXECUTION_RESOURCE_MIME_TYPE, text: artifact.html }],
      };
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const clientName = callerClientFromMeta(request.params._meta as Record<string, unknown> | undefined, declaredClient);
    switch (request.params.name) {
      case 'mma_run':
        return handleRun(deps, args, clientName);
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
      case 'mma_task_list':
        return handleList(deps, args);
      case 'mma_task_cancel':
        return handleCancel(deps, args);
      case 'mma_context_block_create':
        return handleContextBlockCreate(deps, args);
      case 'mma_context_block_delete':
        return handleContextBlockDelete(deps, args);
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
  // Resolved here, not inside the tool handler: this adapter is stateless per
  // request, so the header is the only place the declaration survives. Validated
  // against the same allowlist REST uses, so an arbitrary header value cannot
  // invent a client id — an unrecognised one resolves to `other`, and `other` is
  // no better than the `mcp` default, so it is dropped rather than propagated.
  const declared = resolveCallerIdentity(req).callerClient;
  const server = buildMcpServer(deps, declared === 'other' ? undefined : declared);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
