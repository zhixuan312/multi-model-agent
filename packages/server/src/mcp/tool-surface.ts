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
 * The ONE capability declaration for this server.
 *
 * Both the SDK `Server` constructor and the `server/discover` handler read this exact
 * binding. Two hand-maintained copies would drift, and a discover response that
 * disagrees with `initialize` is worse than having no discover at all.
 *
 * `extensions` is present and deliberately EMPTY. In particular it does not declare
 * `io.modelcontextprotocol/ui` (MCP Apps): an extension declaration is a promise to a
 * host, and a host seeing that key may preload UI resources this server cannot serve.
 * It is added in the same change that first serves a real `ui://` resource.
 *
 * There is likewise no `resources` capability, because no resource handler is
 * registered — `resources/list` and `resources/read` correctly answer method-not-found.
 */
export const MCP_CAPABILITIES = {
  tools: {},
  extensions: {},
} as const;

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

/** Default + ceiling for mma_task_wait. */
export const WAIT_DEFAULT_MS = 55_000;
export const WAIT_CAP_MS = 240_000;

const requestJsonSchema = z.toJSONSchema(taskInputSchema) as Record<string, unknown>;
delete requestJsonSchema.$schema; // rides inside a tool inputSchema — no standalone dialect header

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'mma_run',
    description:
      'Run an MMA task (audit, investigate, delegate, execute_plan, review, debug, research, '
      + 'journal_recall, journal_record, orchestrate, spec, plan) on a cost-optimized worker '
      + 'with cross-model review. Returns either the final result (short tasks) or a task '
      + 'handle { taskId } to poll with mma_task_get / mma_task_wait and cancel with '
      + 'mma_task_cancel. The runtime decides delivery unless `mode` forces it.',
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
  },
  {
    name: 'mma_task_get',
    description:
      'Get the current state of an MMA task. Running tasks return progress '
      + '(phase, elapsed, cancellationRequested); terminal tasks return the full result '
      + 'envelope. Terminal results survive daemon restarts.',
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
    name: 'mma_task_wait',
    description:
      'Block until an MMA task reaches a terminal state (or the timeout elapses), then '
      + 'return the same payload as mma_task_get.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Handle returned by mma_run.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: WAIT_CAP_MS,
          description: `Max wait in milliseconds (default ${WAIT_DEFAULT_MS}, capped at ${WAIT_CAP_MS}).`,
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
