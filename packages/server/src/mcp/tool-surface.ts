// MCP tool surface — four tools, no per-type aliases.
//
// The `type` enum inside `request` is the discoverability mechanism: one entry
// point (`mma_run`), twelve documented task types. Per-type tools would make
// the internal registry a public compatibility surface and duplicate the
// skill-carried "which type, when" semantics.
//
// `request`'s JSON Schema is GENERATED from the same Zod discriminated union
// the REST adapter validates with (core/src/unified/task-input-schema.ts) —
// never a hand-written second schema that could drift.

import { z } from 'zod';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';
import { EXECUTION_RESOURCE_URI } from './execution-artifact.js';

/*
 * SDK-PROTOCOL-RECHECK
 *
 * Pinned SDK: @modelcontextprotocol/sdk 1.30.0 (the latest published release).
 * Negotiated protocol: 2025-11-25 — the SDK's own `LATEST_PROTOCOL_VERSION`.
 *
 * MMA reports only a protocol version its SDK can actually negotiate. The
 * 2026-07-28 revision is published as a specification but the TypeScript SDK does
 * not implement it, and hand-rolling that version would mean fighting the SDK's own
 * negotiation logic — a worse outcome than negotiating 2025-11-25 honestly.
 *
 * TRIGGER: when a future SDK release changes `LATEST_PROTOCOL_VERSION` away from
 * 2025-11-25, revisit both the protocol version reported by `server/discover` and the
 * hand-rolled `server/discover` request schema in mcp-adapter.ts — that method has no
 * schema in 1.30.0, which is why it is defined locally.
 */

/**
 * The two frozen capability literals this server can ever declare, plus the pure
 * selector between them (below).
 *
 * Both the SDK `Server` constructor and the `server/discover` handler read the SAME
 * resolved binding (carried on `McpAdapterDeps.capabilities`, resolved once at daemon
 * start in `http/server.ts`). Two hand-maintained copies would drift, and a discover
 * response that disagrees with `initialize` is worse than having no discover at all.
 *
 * This one declares `resources` and the `io.modelcontextprotocol/ui` extension — a
 * promise to the host that this server can serve UI resources — selected ONLY once a
 * real execution-app bundle backs it (see `execution-artifact.ts`).
 */
export const MCP_CAPABILITIES_WITH_APP = {
  tools: {},
  resources: {},
  extensions: { 'io.modelcontextprotocol/ui': {} },
} as const;

/**
 * Byte-identical to the pre-Flow-2 value: `extensions` is present and deliberately
 * EMPTY, and there is no `resources` capability, so `resources/list` / `resources/read`
 * correctly answer method-not-found when no real `ui://` resource is available to serve.
 */
export const MCP_CAPABILITIES_TOOLS_ONLY = {
  tools: {},
  extensions: {},
} as const;

export type McpCapabilities = typeof MCP_CAPABILITIES_TOOLS_ONLY | typeof MCP_CAPABILITIES_WITH_APP;

/**
 * PURE selector between the two frozen capability literals. No I/O — the caller
 * (`http/server.ts`) resolves `executionAppResourceAvailable` from
 * `getExecutionArtifact().available` exactly once at daemon start and passes the
 * result down as `McpAdapterDeps.capabilities`; `buildMcpServer` never recomputes it.
 */
export function resolveMcpCapabilities(executionAppResourceAvailable: boolean): McpCapabilities {
  return executionAppResourceAvailable ? MCP_CAPABILITIES_WITH_APP : MCP_CAPABILITIES_TOOLS_ONLY;
}

/** The protocol version this server reports. See SDK-PROTOCOL-RECHECK above. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** How the caller wants the result delivered. A preference, not a force —
 *  work likely to exceed the transport's patience is promoted to a handle. */
export const DELIVERY_MODES = ['auto', 'inline', 'handle'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Task types short enough to complete within an inline tool call. Everything
 *  else returns a handle under 'auto'. */
export const INLINE_AUTO_TYPES = new Set(['journal_recall', 'journal_record']);

/** Upper bound one tool call will block waiting for an inline result before
 *  downgrading to a handle. Below typical MCP client tool timeouts. */
export const INLINE_WAIT_CAP_MS = 55_000;

/**
 * Default + ceiling for mma_task_wait — the SAME bound as `INLINE_WAIT_CAP_MS`, and for the
 * same reason.
 *
 * The ceiling was 240s, four times the typical MCP client tool timeout. A long-poll cannot
 * outlive the deadline the CLIENT enforces on the request carrying it: the host kills the
 * JSON-RPC call and the caller sees `-32001 Request timed out` with no snapshot, no taskId
 * context, and no indication the work is still running fine. Observed on Claude Desktop —
 * the model read `capped at 240000` from this schema, asked for it, and got exactly that.
 *
 * Advertising a wait the transport cannot deliver invites the failure. Anything longer is
 * expressed by CALLING AGAIN, which costs one cheap turn and always works.
 */
export const WAIT_DEFAULT_MS = 55_000;
export const WAIT_CAP_MS = 55_000;

const requestJsonSchema = z.toJSONSchema(taskInputSchema) as Record<string, unknown>;
delete requestJsonSchema.$schema; // rides inside a tool inputSchema — no standalone dialect header

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Host-facing metadata. Only `mma_run` carries `ui.resourceUri` — it is the sole
   *  tool whose result is meant to be rendered by an MCP-App-capable host. */
  _meta?: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'mma_run',
    description:
      'Run an MMA task (audit, investigate, delegate, execute_plan, review, debug, research, '
      + 'journal_recall, journal_record, orchestrate, spec, plan) on a cost-optimized worker '
      + 'with cross-model review. Returns either the final result (short tasks) or a task '
      + 'handle { taskId, type, cwd } to poll with mma_task_get / mma_task_wait and cancel '
      + 'with mma_task_cancel. The runtime decides delivery unless `mode` forces it.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute path of the project the task runs against.',
        },
        request: requestJsonSchema,
        mode: {
          type: 'string',
          enum: [...DELIVERY_MODES],
          description:
            "Delivery preference. 'handle' always returns a taskId immediately; 'inline' waits "
            + "for the result (downgraded to a handle if the task outlives the wait budget); "
            + "'auto' (default) inlines short task types and hands back a handle for long ones.",
        },
        mainModel: {
          type: 'string',
          description:
            "The calling agent's own model id (e.g. claude-opus-5). Used to compute "
            + 'main-model-equivalent cost savings in telemetry.',
        },
      },
      required: ['cwd', 'request'],
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: EXECUTION_RESOURCE_URI } },
  },
  {
    name: 'mma_task_get',
    description:
      'Get the current state of an MMA task. Running tasks return identity (type, subtype, '
      + 'cwd) plus progress (phase, elapsed, runningHeadline, cancellationRequested); terminal '
      + 'tasks return the full result envelope. Terminal results survive daemon restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Handle returned by mma_run.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mma_task_list',
    description:
      'List every MMA task currently in flight, oldest first — each with its type '
      + '(spec, review, investigate, …), cwd, phase, elapsed time and current activity. Use '
      + 'this to see what is running when you no longer hold a taskId, or to check what else '
      + 'is competing for a project before dispatching. Finished tasks are not listed; fetch '
      + 'those by id with mma_task_get.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description:
            'Absolute path. When given, lists only tasks running against that project; '
            + 'omit to list every in-flight task on this daemon.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'mma_task_wait',
    description:
      'Block until an MMA task reaches a terminal state (or the timeout elapses), then '
      + 'return the same payload as mma_task_get. A timeout is NOT an error and NOT a '
      + 'failure of the task: it returns the current running snapshot, and the task keeps '
      + 'going. To wait longer, call again with the same taskId.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Handle returned by mma_run.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          // Deliberately NO `maximum`. The server clamps to WAIT_CAP_MS anyway
          // (mcp-adapter.ts), so a ceiling here converts a request the server would happily
          // satisfy into a hard -32602 validation error. Asking to wait "5 minutes" is a
          // perfectly reasonable intent; the right answer is a 55s wait and a running
          // snapshot, not a schema violation the model has to decode and retry.
          description:
            `Max wait in milliseconds (default ${WAIT_DEFAULT_MS}). Larger values are `
            + `accepted and clamped to ${WAIT_CAP_MS}, which is the most a single MCP tool `
            + `call can block before the client's own request deadline fires.`,
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mma_task_cancel',
    description:
      'Request cooperative cancellation of a running MMA task. Cancellation is requested, '
      + 'not instantaneous: the task keeps running until the worker confirms termination, then '
      + 'reaches terminal cancelled — unless completion won the race, in which case the '
      + 'completed result stands. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Handle returned by mma_run.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];
