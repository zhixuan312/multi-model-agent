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
