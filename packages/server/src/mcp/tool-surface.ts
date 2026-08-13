// MCP tool surface — seven tools, no per-type aliases.
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
import {
  taskInputSchema,
  initiativeOperationRequestSchema,
  initiativeMutationRequestSchema,
  initiativeResumeRequestSchema,
  INITIATIVE_OPERATIONS,
  type InitiativeOperation,
} from '@zhixuan92/multi-model-agent-core';
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

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Host-facing metadata. Only `mma_run` carries `ui.resourceUri` — it is the sole
   *  tool whose result is meant to be rendered by an MCP-App-capable host. */
  _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Initiative Record — one `mma_<operation>` tool per frozen operation
// (SPEC-001 "Interfaces / contracts"; see initiative-record-runtime.ts for the
// shared runtime every adapter — HTTP, MCP, CLI — calls into). The `operation`
// selector every other transport carries in its request body is carried here
// by the TOOL NAME instead: the discriminant is dropped from each tool's
// `inputSchema` (the adapter injects the literal before validating), so a
// caller never supplies it twice.
//
// Every JSON Schema below is generated from the actual member of
// `initiativeOperationRequestSchema` — the SAME discriminated union
// `InitiativeRecordRuntime.execute()` validates against (Task I-6) — never a
// hand-written second copy of the Product/Workspace/Initiative/Task/ArtifactRef
// field rules.

/** Every operation whose envelope carries `MutationControl` (`expected_revision`,
 *  optional `idempotency_key`, `provenance`) — the Phase A0 nine plus the Phase A1
 *  nine, derived from `initiativeMutationRequestSchema` (the exact discriminated
 *  union `schemas.ts`'s private `mutating()` builder produces) rather than a
 *  hand-maintained duplicate list that could silently drift when a future phase
 *  adds another mutation. Read here so the MCP adapter knows which calls need
 *  adapter-owned provenance stamped (`interface: 'mcp'`, server timestamp) before
 *  dispatch. */
export const INITIATIVE_MUTATING_OPERATIONS = new Set<InitiativeOperation>(
  (initiativeMutationRequestSchema.options as readonly z.ZodTypeAny[]).map(
    (member) => (member as z.ZodObject<{ operation: z.ZodLiteral<string> }>).shape.operation.value as InitiativeOperation,
  ),
);

/** `mma_<operation>` -> `<operation>`, for every operation EXCEPT
 *  `initiative_resume` (its own dedicated tool/handler — see below). Built
 *  from the frozen `INITIATIVE_OPERATIONS` list so a tool name can never name
 *  an operation `execute()` does not also recognise. */
export const INITIATIVE_EXECUTE_OPERATION_BY_TOOL_NAME: ReadonlyMap<string, InitiativeOperation> = new Map(
  INITIATIVE_OPERATIONS
    .filter((operation) => operation !== 'initiative_resume')
    .map((operation) => [`mma_${operation}`, operation] as const),
);

const initiativeOperationSchemaMembers = initiativeOperationRequestSchema.options as readonly z.ZodTypeAny[];

/** Looks up the exact `initiativeOperationRequestSchema` member for one
 *  operation — the literal schema `execute()` validates a matching request
 *  body against. */
function initiativeOperationSchemaFor(operation: InitiativeOperation): z.ZodTypeAny {
  const match = initiativeOperationSchemaMembers.find(
    (member) => (member as z.ZodObject<{ operation: z.ZodLiteral<string> }>).shape.operation.value === operation,
  );
  if (!match) throw new Error(`no initiativeOperationRequestSchema member for operation: ${operation}`);
  return match;
}

/** JSON Schema for one `mma_<operation>` tool's arguments: the matching
 *  `initiativeOperationRequestSchema` member, minus the `operation` field
 *  (redundant — the tool name already selects it; the adapter injects the
 *  literal before validating the real request). */
function initiativeToolInputSchema(operation: InitiativeOperation): Record<string, unknown> {
  const full = z.toJSONSchema(initiativeOperationSchemaFor(operation)) as Record<string, unknown>;
  delete full.$schema;
  const properties = { ...(full.properties as Record<string, unknown> | undefined) };
  delete properties.operation;
  const required = ((full.required as string[] | undefined) ?? []).filter((key) => key !== 'operation');
  // The adapter stamps `provenance.interface` and `provenance.timestamp` on
  // every mutation, discarding caller input — so the advertised schema must
  // not declare them caller-required.
  const provenance = properties.provenance as Record<string, unknown> | undefined;
  if (provenance && typeof provenance === 'object') {
    const provProperties = { ...(provenance.properties as Record<string, unknown> | undefined) };
    delete provProperties.interface;
    delete provProperties.timestamp;
    const provRequired = ((provenance.required as string[] | undefined) ?? []).filter(
      (key) => key !== 'interface' && key !== 'timestamp',
    );
    properties.provenance = { ...provenance, properties: provProperties, required: provRequired };
  }
  return { ...full, properties, required };
}

const initiativeResumeInputSchema: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(initiativeResumeRequestSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

/** Human-facing description per Initiative operation. Mutating ones name their
 *  `MutationControl` requirement; the adapter always overwrites
 *  `provenance.interface`/`provenance.timestamp` regardless of caller input. */
const INITIATIVE_TOOL_DESCRIPTIONS: Record<InitiativeOperation, string> = {
  product_create:
    'Create a Product, the top-level container Workspaces and Initiatives attach to. Mutating: pass '
    + 'expected_revision (0 for a new Product) and provenance; the server overwrites provenance.interface/timestamp.',
  product_get: 'Look up a Product by uuid or slug (exactly one).',
  product_list: 'List every Product.',
  workspace_create:
    'Create a Workspace under a Product, e.g. a repo boundary Resources and Initiatives attach to. Mutating: pass '
    + 'expected_revision and provenance.',
  workspace_get: 'Look up a Workspace by uuid.',
  workspace_list: 'List Workspaces, optionally filtered to one Product.',
  resource_register:
    'Register a Resource (e.g. a git repository) under a Workspace. Mutating: pass expected_revision and provenance.',
  resource_list: 'List the Resources registered under a Workspace.',
  initiative_create:
    'Create an Initiative: a durable, resumable unit of product work with a title, goal, and status. Mutating: pass '
    + 'expected_revision and provenance.',
  initiative_get: 'Look up an Initiative by uuid or human_key (e.g. MMA-INIT-001).',
  initiative_list: 'List Initiatives, optionally filtered by product_id and/or status.',
  initiative_status:
    "Change an Initiative's status/outcome (open with null outcome, or closed with one non-null outcome). "
    + 'Mutating: pass expected_revision and provenance.',
  initiative_link_workspace:
    'Link an Initiative to a Workspace with a role (consumes/references/modifies/creates/delivers_to); the '
    + "Workspace must belong to the Initiative's own Product. Mutating: pass expected_revision and provenance.",
  initiative_relate:
    'Relate two Initiatives (depends_on/blocks/supersedes/related_to). Mutating: pass expected_revision and provenance.',
  initiative_relations: "List an Initiative's relations to other Initiatives.",
  initiative_task_create:
    'Create a Task under an Initiative, optionally scoped to Workspaces/Resources and linked execution refs. '
    + 'Mutating: pass expected_revision and provenance.',
  initiative_task_get: 'Look up an Initiative Task by uuid.',
  initiative_task_list: 'List the Tasks under an Initiative.',
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
  initiative_task_claim:
    "Claim an open Initiative Task, setting claimed_by to the caller's provenance.actor_id (open -> claimed "
    + "only; any other status rejects task_not_claimable). Mutating: pass expected_revision and provenance.",
  initiative_task_release:
    'Release a claimed or in_progress Initiative Task back to open, clearing claimed_by (claimed|in_progress -> '
    + 'open only). Only the claimant may release, except a human-provenance caller may release any claim. '
    + 'Mutating: pass expected_revision and provenance.',
  initiative_task_complete:
    'Complete a claimed or in_progress Initiative Task with a required outcome (claimed|in_progress -> completed '
    + 'only; only the claimant may complete). Mutating: pass expected_revision and provenance.',
  initiative_task_execution:
    'Record an execution_ref against an Initiative Task (appended once, idempotent) and optionally apply one '
    + 'permitted status transition; rejected once the Task is completed or cancelled. Mutating: pass '
    + 'expected_revision and provenance.',
  artifact_register:
    'Register an ArtifactRef (managed or external) produced for or consumed by an Initiative. Mutating: pass '
    + 'expected_revision and provenance.',
  artifact_get: 'Look up an ArtifactRef by uuid.',
  initiative_resume:
    'Assemble the complete continuation payload for one Initiative in a single call: the Initiative, its Product, '
    + 'linked Workspaces and their Resources, related Initiatives, Tasks, ArtifactRefs, the most recent Events '
    + '(event_limit, default 20, max 100), and summary counts. Use this to resume work on an Initiative from a '
    + 'fresh session without a handover document.',
  // Phase A1 — professional record and verification ledger (SPEC-002 FR-4).
  requirement_add:
    'Add a Requirement (a statement of what the Initiative must satisfy) to an Initiative. Mutating: pass '
    + 'expected_revision and provenance.',
  requirement_get: 'Look up a Requirement by uuid, or by (initiative_id, human_key) together.',
  requirement_list: 'List the Requirements under an Initiative.',
  acceptance_criterion_add:
    'Add an AcceptanceCriterion (a checkable statement with a check_reference) to a Requirement. Mutating: pass '
    + 'expected_revision and provenance.',
  acceptance_criterion_get: 'Look up an AcceptanceCriterion by uuid, or by (requirement_id, human_key) together.',
  acceptance_criterion_list: 'List the AcceptanceCriteria under a Requirement, or under an Initiative as a whole.',
  decision_record:
    'Record a Decision (title, decision, rationale, alternatives considered, status) against an Initiative. '
    + 'Mutating: pass expected_revision and provenance.',
  decision_supersede:
    'Supersede an existing Decision with a new one in one transaction: the old Decision is marked superseded and '
    + 'the new Decision is recorded decided. Identify the old Decision by uuid or by (initiative_id, human_key). '
    + 'Mutating: pass expected_revision and provenance.',
  decision_get: 'Look up a Decision by uuid, or by (initiative_id, human_key) together.',
  decision_list: 'List the Decisions under an Initiative.',
  evidence_add:
    'Add Evidence (kind, locator, optional content_hash, summary) supporting an Initiative. Mutating: pass '
    + 'expected_revision and provenance.',
  evidence_get: 'Look up Evidence by uuid, or by (initiative_id, locator) together.',
  evidence_list: 'List the Evidence recorded under an Initiative.',
  evidence_link:
    'Link Evidence to a target record (a Requirement, AcceptanceCriterion, Decision, VerificationRun, or Task) '
    + "within the Evidence's own Initiative. Mutating: pass expected_revision and provenance.",
  evidence_links_list:
    'List EvidenceLinks, either every link from one piece of Evidence or every link pointing at one target record.',
  risk_add:
    'Add a Risk (statement, severity, initial status) to an Initiative. Mutating: pass expected_revision and '
    + 'provenance.',
  risk_status:
    "Change a Risk's status. Identify the Risk by uuid or by (initiative_id, human_key). Mutating: pass "
    + 'expected_revision and provenance.',
  risk_get: 'Look up a Risk by uuid, or by (initiative_id, human_key) together.',
  risk_list: 'List the Risks under an Initiative.',
  verification_record:
    'Record an immutable VerificationRun (method, state, detail) against an AcceptanceCriterion. Mutating: pass '
    + 'expected_revision and provenance.',
  verification_get: 'Look up a VerificationRun by uuid.',
  verification_list: 'List the VerificationRuns for one AcceptanceCriterion, or for an Initiative as a whole.',
};

/** One `mma_<operation>` tool per frozen Initiative operation (FR-3/FR-4,
 *  AC-2.1). `initiative_resume` uses its own request shape (no `operation`/
 *  `input` envelope — see `initiativeResumeRequestSchema`); every other
 *  operation uses the matching `initiativeOperationRequestSchema` member. */
const INITIATIVE_MCP_TOOLS: McpToolDefinition[] = INITIATIVE_OPERATIONS.map((operation) => ({
  name: `mma_${operation}`,
  description: INITIATIVE_TOOL_DESCRIPTIONS[operation],
  inputSchema: operation === 'initiative_resume' ? initiativeResumeInputSchema : initiativeToolInputSchema(operation),
}));

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
      },
      // No `mainModel`: the cost baseline is the daemon's configured `agents.main`.
      required: ['cwd', 'request'],
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: EXECUTION_RESOURCE_URI } },
  },
  {
    name: 'mma_task_get',
    description:
      'Get the current state of an MMA task. Running tasks return identity (type, subtype '
      + '[audit only], practice [plan/execute_plan/review/debug only], cwd) plus progress '
      + '(phase, elapsed, runningHeadline, cancellationRequested); terminal tasks return the '
      + 'full result envelope. Terminal results survive daemon restarts.',
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
  {
    name: 'mma_context_block_create',
    description:
      'Register a reusable block of context (e.g. a large file, spec, or transcript) that a '
      + 'later mma_run can reference by id via request.contextBlockIds, instead of inlining the '
      + 'content into the prompt. Blocks are project-isolated (scoped to `cwd`) and expire after '
      + 'ttlMs (default 24h) or the server-configured default when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute path of the project that will own this block.',
        },
        content: {
          type: 'string',
          description: 'Block content. Must be non-empty and under the server-configured byte limit.',
        },
        ttlMs: {
          type: 'integer',
          minimum: 1,
          description: 'Optional per-block time-to-live in milliseconds; defaults to the server-configured value when omitted.',
        },
      },
      required: ['cwd', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'mma_context_block_delete',
    description:
      'Delete a context block created by mma_context_block_create. Fails with `pinned` if the '
      + 'block is still referenced by an in-flight batch, and `not_found` for an unknown id or '
      + 'one owned by a different project.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute path of the project that owns the block.',
        },
        blockId: { type: 'string', description: 'Id returned by mma_context_block_create.' },
      },
      required: ['cwd', 'blockId'],
      additionalProperties: false,
    },
  },
  ...INITIATIVE_MCP_TOOLS,
];
