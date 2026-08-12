/**
 * Initiative Record — frozen Zod boundary schemas (Phase A0 kernel).
 *
 * TRANSCRIPTION, not design: validates exactly the request shapes SPEC-001 pins in
 * "Interfaces / contracts" and the pairing rules in "Data model". Every mutating
 * operation's `input` schema is combined with the common `MutationControl` fields
 * (`expected_revision`, optional `idempotency_key`, `provenance`); every read
 * operation's `input` schema stands alone. `initiativeOperationRequestSchema` is the
 * generic `{ operation, input, ...control? }` envelope a transport-agnostic dispatcher
 * validates against; `initiativeResumeRequestSchema` (and the per-operation schemas
 * below) double as the argument schema for a transport where the operation is already
 * selected by the call site (e.g. one MCP tool per operation).
 *
 * Zod rejects invalid UUIDs, empty required provenance strings, invalid enum values,
 * missing required values, and JSON-list values that are not string arrays (AC-1.2).
 */
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const nonEmptyString = z.string().min(1);
/** Exact `MMA-INIT-<n>` pattern (FR-6), including the pinned bootstrap key `MMA-INIT-001`. */
const humanKeySchema = z.string().regex(/^MMA-INIT-\d+$/, 'must match MMA-INIT-<n>');

export const provenanceSchema = z
  .object({
    actor_type: z.enum(['human', 'agent', 'system']),
    actor_id: nonEmptyString,
    interface: nonEmptyString,
    initiated_by: nonEmptyString,
    authorized_by: nonEmptyString,
    /** RFC 3339 UTC timestamp. The adapter overwrites this with the server clock regardless of caller input. */
    timestamp: nonEmptyString,
    source: nonEmptyString,
  })
  .strict();
export type ProvenanceInput = z.infer<typeof provenanceSchema>;

const mutationControlFields = {
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: nonEmptyString.optional(),
  provenance: provenanceSchema,
};

/** Builds the `{ operation, input, expected_revision, idempotency_key?, provenance }` envelope for a mutating op. */
function mutating<Op extends string, InputSchema extends z.ZodType>(operation: Op, input: InputSchema) {
  return z
    .object({
      operation: z.literal(operation),
      input,
      ...mutationControlFields,
    })
    .strict();
}

/** Builds the `{ operation, input }` envelope for a read-only op (no `MutationControl`). */
function readOnly<Op extends string, InputSchema extends z.ZodType>(operation: Op, input: InputSchema) {
  return z
    .object({
      operation: z.literal(operation),
      input,
    })
    .strict();
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export const productCreateInputSchema = z.object({ name: nonEmptyString, slug: nonEmptyString }).strict();
export type ProductCreateInput = z.infer<typeof productCreateInputSchema>;

export const productLookupInputSchema = z
  .object({ uuid: uuidSchema.optional(), slug: nonEmptyString.optional() })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.slug !== undefined), {
    message: 'exactly one of uuid or slug is required',
  });
export type ProductLookupInput = z.infer<typeof productLookupInputSchema>;

export const productListInputSchema = z.object({}).strict();
export type ProductListInput = z.infer<typeof productListInputSchema>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const workspaceCreateInputSchema = z
  .object({
    product_id: uuidSchema,
    name: nonEmptyString,
    slug: nonEmptyString,
    description: nonEmptyString,
  })
  .strict();
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;

export const workspaceGetInputSchema = z.object({ uuid: uuidSchema }).strict();
export type WorkspaceGetInput = z.infer<typeof workspaceGetInputSchema>;

export const workspaceListInputSchema = z.object({ product_id: uuidSchema.optional() }).strict();
export type WorkspaceListInput = z.infer<typeof workspaceListInputSchema>;

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export const resourceRegisterInputSchema = z
  .object({
    workspace_id: uuidSchema,
    type: nonEmptyString,
    canonical_locator: nonEmptyString,
    local_path: nonEmptyString.optional(),
    description: nonEmptyString,
  })
  .strict();
export type ResourceRegisterInput = z.infer<typeof resourceRegisterInputSchema>;

export const resourceListInputSchema = z.object({ workspace_id: uuidSchema }).strict();
export type ResourceListInput = z.infer<typeof resourceListInputSchema>;

// ---------------------------------------------------------------------------
// Initiative
// ---------------------------------------------------------------------------

const initiativeStatusSchema = z.enum(['open', 'closed']);
const initiativeOutcomeSchema = z
  .enum(['delivered', 'cancelled', 'abandoned', 'superseded', 'closed_with_concerns'])
  .nullable();

/**
 * `initiative_create` and `initiative_status` both accept only `status: 'open', outcome: null`
 * or `status: 'closed'` with one non-null outcome (AC-1.9, CONFIRMED — not a proposal).
 */
function refineStatusOutcomePairing<T extends { status: 'open' | 'closed'; outcome: unknown }>(
  value: T,
  ctx: z.RefinementCtx,
) {
  if (value.status === 'open' && value.outcome !== null) {
    ctx.addIssue({ code: 'custom', path: ['outcome'], message: "outcome must be null when status is 'open'" });
  }
  if (value.status === 'closed' && value.outcome === null) {
    ctx.addIssue({ code: 'custom', path: ['outcome'], message: "outcome must be non-null when status is 'closed'" });
  }
}

export const initiativeCreateInputSchema = z
  .object({
    product_id: uuidSchema,
    title: nonEmptyString,
    goal: nonEmptyString,
    status: initiativeStatusSchema,
    outcome: initiativeOutcomeSchema,
  })
  .strict()
  .superRefine(refineStatusOutcomePairing);
export type InitiativeCreateInput = z.infer<typeof initiativeCreateInputSchema>;

export const initiativeLookupSchema = z
  .object({ uuid: uuidSchema.optional(), human_key: humanKeySchema.optional() })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.human_key !== undefined), {
    message: 'exactly one of uuid or human_key is required',
  });
export type InitiativeLookupInput = z.infer<typeof initiativeLookupSchema>;

export const initiativeListInputSchema = z
  .object({ product_id: uuidSchema.optional(), status: initiativeStatusSchema.optional() })
  .strict();
export type InitiativeListInput = z.infer<typeof initiativeListInputSchema>;

export const initiativeStatusInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    human_key: humanKeySchema.optional(),
    status: initiativeStatusSchema,
    outcome: initiativeOutcomeSchema,
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.human_key !== undefined), {
    message: 'exactly one of uuid or human_key is required',
  })
  .superRefine(refineStatusOutcomePairing);
export type InitiativeStatusInput = z.infer<typeof initiativeStatusInputSchema>;

/** `initiative_resume` request — also SPEC-001's standalone `InitiativeResumeRequest` schema. */
export const initiativeResumeRequestSchema = z
  .object({
    initiative: initiativeLookupSchema,
    event_limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type InitiativeResumeRequestInput = z.infer<typeof initiativeResumeRequestSchema>;

export const initiativeLinkWorkspaceInputSchema = z
  .object({
    initiative_id: uuidSchema,
    workspace_id: uuidSchema,
    role: z.enum(['consumes', 'references', 'modifies', 'creates', 'delivers_to']),
  })
  .strict();
export type InitiativeLinkWorkspaceInput = z.infer<typeof initiativeLinkWorkspaceInputSchema>;

export const initiativeRelateInputSchema = z
  .object({
    from_id: uuidSchema,
    to_id: uuidSchema,
    type: z.enum(['depends_on', 'blocks', 'supersedes', 'related_to']),
  })
  .strict();
export type InitiativeRelateInput = z.infer<typeof initiativeRelateInputSchema>;

export const initiativeRelationsInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type InitiativeRelationsInput = z.infer<typeof initiativeRelationsInputSchema>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const taskStatusSchema = z.enum(['open', 'claimed', 'in_progress', 'blocked', 'completed', 'cancelled']);
const taskOutcomeSchema = z.enum(['succeeded', 'succeeded_with_concerns', 'failed', 'not_completed']).nullable();
const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled']);

export const initiativeTaskCreateInputSchema = z
  .object({
    initiative_id: uuidSchema,
    title: nonEmptyString,
    goal: nonEmptyString,
    status: taskStatusSchema,
    outcome: taskOutcomeSchema,
    workspace_ids: z.array(uuidSchema),
    resource_ids: z.array(uuidSchema),
    executionRefs: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isTerminal = TERMINAL_TASK_STATUSES.has(value.status);
    if (!isTerminal && value.outcome !== null) {
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome must be null for a non-terminal status' });
    }
    if (isTerminal && value.outcome === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: "outcome must be non-null for 'completed' or 'cancelled'",
      });
    }
  });
export type InitiativeTaskCreateInput = z.infer<typeof initiativeTaskCreateInputSchema>;

export const initiativeTaskGetInputSchema = z.object({ uuid: uuidSchema }).strict();
export type InitiativeTaskGetInput = z.infer<typeof initiativeTaskGetInputSchema>;

export const initiativeTaskListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type InitiativeTaskListInput = z.infer<typeof initiativeTaskListInputSchema>;

// ---------------------------------------------------------------------------
// ArtifactRef
// ---------------------------------------------------------------------------

export const artifactRegisterInputSchema = z
  .object({
    initiative_id: uuidSchema,
    storage_mode: z.enum(['managed', 'external']),
    path_or_uri: nonEmptyString,
    content_hash: nonEmptyString.optional(),
    media_type: nonEmptyString.optional(),
    version: nonEmptyString.optional(),
    produced_by_task: uuidSchema.optional(),
    description: nonEmptyString,
  })
  .strict();
export type ArtifactRegisterInput = z.infer<typeof artifactRegisterInputSchema>;

export const artifactGetInputSchema = z.object({ uuid: uuidSchema }).strict();
export type ArtifactGetInput = z.infer<typeof artifactGetInputSchema>;

// ---------------------------------------------------------------------------
// The generic operation envelope
// ---------------------------------------------------------------------------

/**
 * The frozen Phase A0 operation set as one discriminated-union request envelope
 * (FR-3). A transport-agnostic dispatcher validates a wire body against this
 * schema and routes on `operation`.
 */
export const initiativeOperationRequestSchema = z.discriminatedUnion('operation', [
  mutating('product_create', productCreateInputSchema),
  readOnly('product_get', productLookupInputSchema),
  readOnly('product_list', productListInputSchema),

  mutating('workspace_create', workspaceCreateInputSchema),
  readOnly('workspace_get', workspaceGetInputSchema),
  readOnly('workspace_list', workspaceListInputSchema),

  mutating('resource_register', resourceRegisterInputSchema),
  readOnly('resource_list', resourceListInputSchema),

  mutating('initiative_create', initiativeCreateInputSchema),
  readOnly('initiative_get', initiativeLookupSchema),
  readOnly('initiative_list', initiativeListInputSchema),
  mutating('initiative_status', initiativeStatusInputSchema),
  readOnly('initiative_resume', initiativeResumeRequestSchema),
  mutating('initiative_link_workspace', initiativeLinkWorkspaceInputSchema),
  mutating('initiative_relate', initiativeRelateInputSchema),
  readOnly('initiative_relations', initiativeRelationsInputSchema),

  mutating('initiative_task_create', initiativeTaskCreateInputSchema),
  readOnly('initiative_task_get', initiativeTaskGetInputSchema),
  readOnly('initiative_task_list', initiativeTaskListInputSchema),

  mutating('artifact_register', artifactRegisterInputSchema),
  readOnly('artifact_get', artifactGetInputSchema),
]);
export type InitiativeOperationRequest = z.infer<typeof initiativeOperationRequestSchema>;
