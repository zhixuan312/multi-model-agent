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
import { DELIVERY_CONTRACT_ID_PATTERN, METHOD_ID_PATTERN } from './types.js';

const uuidSchema = z.string().uuid();
const nonEmptyString = z.string().min(1);
/** Exact `MMA-INIT-<n>` pattern (FR-6), including the pinned bootstrap key `MMA-INIT-001`. */
const humanKeySchema = z.string().regex(/^MMA-INIT-\d+$/, 'must match MMA-INIT-<n>');

// --- SPEC-004 Lifecycle Engine primitives (FR-5) ----------------------------

/** The six frozen phases (FR-1). */
const phaseSchema = z.enum(['discover', 'refine', 'design', 'execute', 'verify', 'deliver']);
/** `<name>@<version>`, version >= 1, no leading zero (FR-5). */
const lifecycleContractIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/, 'must match <name>@<version>, e.g. default-sdl@1');
/** snake_case Establishment key (FR-5). */
const establishmentKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must match snake_case establishment key');

// --- SPEC-005 Method Registry primitives (FR-2) -----------------------------

/** `<name>@<version>`, version >= 1, no leading zero (FR-2). */
const methodIdSchema = z.string().regex(METHOD_ID_PATTERN, 'must match <name>@<version>, e.g. software-change@1');

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
    /**
     * SPEC-004 FR-7: a registered contract id, or omitted — never `null` at create time (`null`
     * is reserved for the later `initiative_set_lifecycle_contract` clearing mutation). Omitted
     * defaults the new Initiative to `'default-sdl@1'`.
     */
    lifecycle_contract: lifecycleContractIdSchema.optional(),
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
// SPEC-006 Business intake — `initiative_bootstrap`, one confirmed-draft
// composite mutation (FR-6, ← AC-1.6). Task I-2 defines the contract only —
// no store dispatch, transaction logic, or runtime wiring; that is Task I-3.
// ---------------------------------------------------------------------------

const bootstrapProductInputSchema = z
  .object({
    create: productCreateInputSchema.optional(),
    existing: z.object({ uuid: uuidSchema }).strict().optional(),
  })
  .strict()
  .refine((v) => (v.create !== undefined) !== (v.existing !== undefined), {
    message: 'exactly one of create or existing is required',
  });

const bootstrapWorkspaceCreateInputSchema = z
  .object({ name: nonEmptyString, slug: nonEmptyString, description: nonEmptyString })
  .strict();

const bootstrapWorkspaceItemInputSchema = z
  .object({
    workspace_key: nonEmptyString,
    role: z.enum(['consumes', 'references', 'modifies', 'creates', 'delivers_to']),
    create: bootstrapWorkspaceCreateInputSchema.optional(),
    existing: z.object({ uuid: uuidSchema }).strict().optional(),
  })
  .strict()
  .refine((v) => (v.create !== undefined) !== (v.existing !== undefined), {
    message: 'exactly one of create or existing is required',
  });

const bootstrapResourceItemInputSchema = z
  .object({
    workspace_key: nonEmptyString,
    type: nonEmptyString,
    canonical_locator: nonEmptyString,
    local_path: nonEmptyString.optional(),
    description: nonEmptyString,
  })
  .strict();

const bootstrapInitiativeInputSchema = z
  .object({
    title: nonEmptyString,
    goal: nonEmptyString,
    status: initiativeStatusSchema,
    outcome: initiativeOutcomeSchema,
    lifecycle_contract: lifecycleContractIdSchema.optional(),
  })
  .strict()
  .superRefine(refineStatusOutcomePairing);

const bootstrapAcceptanceCriterionItemInputSchema = z
  .object({ statement: nonEmptyString, check_reference: nonEmptyString })
  .strict();

const bootstrapRequirementItemInputSchema = z
  .object({
    statement: nonEmptyString,
    acceptance_criteria: z.array(bootstrapAcceptanceCriterionItemInputSchema).optional(),
  })
  .strict();

/**
 * `initiative_bootstrap` — one confirmed intake draft as a single strict input. No Tasks,
 * Executions, Decisions, Evidence, Deliverables, or unknown top-level keys are accepted
 * (`.strict()` on every nested object rejects them). Cross-field checks beyond per-field shape:
 * every `workspaces[].workspace_key` is unique, and every `resources[].workspace_key` names one
 * `workspaces[]` entry in the same request.
 */
export const initiativeBootstrapInputSchema = z
  .object({
    product: bootstrapProductInputSchema,
    workspaces: z.array(bootstrapWorkspaceItemInputSchema).min(1),
    resources: z.array(bootstrapResourceItemInputSchema).optional(),
    initiative: bootstrapInitiativeInputSchema,
    requirements: z.array(bootstrapRequirementItemInputSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenWorkspaceKeys = new Set<string>();
    value.workspaces.forEach((workspace, index) => {
      if (seenWorkspaceKeys.has(workspace.workspace_key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'workspace_key'],
          message: 'duplicate workspace_key within this request',
        });
      }
      seenWorkspaceKeys.add(workspace.workspace_key);
    });
    (value.resources ?? []).forEach((resource, index) => {
      if (!seenWorkspaceKeys.has(resource.workspace_key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', index, 'workspace_key'],
          message: 'workspace_key does not name a workspaces entry in this request',
        });
      }
    });
  });
export type InitiativeBootstrapInput = z.infer<typeof initiativeBootstrapInputSchema>;

// ---------------------------------------------------------------------------
// SPEC-004 Lifecycle Engine — phase/focus mutations, contract reference, and
// the advisory gate read (FR-2 through FR-9). Every lifecycle request
// identifies the Initiative through the same `{ uuid?, human_key? }` lookup
// selector as every other Initiative-scoped operation, nested under
// `initiative` (frozen "Interfaces / contracts" shape) rather than the flat
// top-level `uuid`/`human_key` fields older operations use.
// ---------------------------------------------------------------------------

export const initiativePhaseEnterInputSchema = z
  .object({ initiative: initiativeLookupSchema, phase: phaseSchema })
  .strict();
export type InitiativePhaseEnterInput = z.infer<typeof initiativePhaseEnterInputSchema>;

/** `asserted` is optional; omitted normalizes to `[]` at the store (FR-2, "Interfaces / contracts"). */
export const initiativePhaseSatisfyInputSchema = z
  .object({
    initiative: initiativeLookupSchema,
    phase: phaseSchema,
    asserted: z
      .array(establishmentKeySchema)
      .optional()
      .refine((asserted) => asserted === undefined || new Set(asserted).size === asserted.length, {
        message: 'must not contain duplicate establishment keys',
      }),
  })
  .strict();
export type InitiativePhaseSatisfyInput = z.infer<typeof initiativePhaseSatisfyInputSchema>;

export const initiativePhaseReopenInputSchema = z
  .object({ initiative: initiativeLookupSchema, phase: phaseSchema, reason: nonEmptyString })
  .strict();
export type InitiativePhaseReopenInput = z.infer<typeof initiativePhaseReopenInputSchema>;

export const initiativePhaseSkipInputSchema = z
  .object({ initiative: initiativeLookupSchema, phase: phaseSchema, reason: nonEmptyString })
  .strict();
export type InitiativePhaseSkipInput = z.infer<typeof initiativePhaseSkipInputSchema>;

export const initiativeFocusSetInputSchema = z
  .object({ initiative: initiativeLookupSchema, phase: phaseSchema })
  .strict();
export type InitiativeFocusSetInput = z.infer<typeof initiativeFocusSetInputSchema>;

/** `lifecycle_contract: null` clears the reference (FR-7); a non-null value must be a registered id. */
export const initiativeSetLifecycleContractInputSchema = z
  .object({ initiative: initiativeLookupSchema, lifecycle_contract: lifecycleContractIdSchema.nullable() })
  .strict();
export type InitiativeSetLifecycleContractInput = z.infer<typeof initiativeSetLifecycleContractInputSchema>;

export const initiativeGateStatusInputSchema = z.object({ initiative: initiativeLookupSchema }).strict();
export type InitiativeGateStatusInput = z.infer<typeof initiativeGateStatusInputSchema>;

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
    /** SPEC-005 Method Registry: an optional registered Method identifier (FR-2). */
    method: methodIdSchema.optional(),
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

// --- Task claim / release / complete / execution (SPEC-003 Phase B, FR-8, FR-9) --------------

/** The non-null `TaskOutcome` values `initiative_task_complete` and a `completed` transition require. */
const taskOutcomeValueSchema = z.enum(['succeeded', 'succeeded_with_concerns', 'failed', 'not_completed']);

export const initiativeTaskClaimInputSchema = z.object({ uuid: uuidSchema }).strict();
export type InitiativeTaskClaimInput = z.infer<typeof initiativeTaskClaimInputSchema>;

export const initiativeTaskReleaseInputSchema = z.object({ uuid: uuidSchema }).strict();
export type InitiativeTaskReleaseInput = z.infer<typeof initiativeTaskReleaseInputSchema>;

export const initiativeTaskCompleteInputSchema = z
  .object({ uuid: uuidSchema, outcome: taskOutcomeValueSchema })
  .strict();
export type InitiativeTaskCompleteInput = z.infer<typeof initiativeTaskCompleteInputSchema>;

/** `transition` is optional; `outcome` is required only when `transition` is `'completed'` (FR-9). */
export const initiativeTaskExecutionInputSchema = z
  .object({
    uuid: uuidSchema,
    execution_ref: nonEmptyString,
    transition: z.enum(['in_progress', 'blocked', 'open', 'completed']).optional(),
    outcome: taskOutcomeValueSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transition === 'completed' && value.outcome === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: "outcome is required when transition is 'completed'",
      });
    }
  });
export type InitiativeTaskExecutionInput = z.infer<typeof initiativeTaskExecutionInputSchema>;

// ---------------------------------------------------------------------------
// SPEC-005 Method Registry — declaration shape and the sole Task Method
// mutation (FR-1 through FR-4). No caller-visible Method write operation
// exists: there is no `method_register`/`_update`/`_delete` schema anywhere
// in this file.
// ---------------------------------------------------------------------------

/**
 * Validates exactly the frozen declaration field set (FR-2): `id`, `name`, `version`,
 * `purpose`, `required_inputs`, `expected_outputs`, and `verification_expectations`. No
 * conditional, script, expression, or extension field is permitted (`.strict()`).
 */
export const methodDeclarationSchema = z
  .object({
    id: methodIdSchema,
    name: nonEmptyString,
    version: z.number().int().positive(),
    purpose: nonEmptyString,
    required_inputs: z.array(z.string()),
    expected_outputs: z.array(z.string()),
    verification_expectations: z.array(z.string()),
  })
  .strict();
export type MethodDeclarationInput = z.infer<typeof methodDeclarationSchema>;

export const methodGetInputSchema = z.object({ id: methodIdSchema }).strict();
export type MethodGetInput = z.infer<typeof methodGetInputSchema>;

export const methodListInputSchema = z.object({}).strict();
export type MethodListInput = z.infer<typeof methodListInputSchema>;

/** `method: null` clears the Task's Method reference; a non-null value must be a registered id. */
export const initiativeTaskSetMethodInputSchema = z
  .object({
    initiative: initiativeLookupSchema,
    task: z.object({ uuid: uuidSchema }).strict(),
    method: methodIdSchema.nullable(),
  })
  .strict();
export type InitiativeTaskSetMethodInput = z.infer<typeof initiativeTaskSetMethodInputSchema>;

// ---------------------------------------------------------------------------
// SPEC-007 Delivery Layer — Delivery Contract registry (Task I-1, FR-1). No
// caller-visible Delivery Contract write operation exists: there is no
// `delivery_contract_register`/`_update`/`_delete` schema anywhere in this
// file.
// ---------------------------------------------------------------------------

/** `<name>@<version>`, version >= 1, no leading zero (FR-1). */
const deliveryContractIdSchema = z
  .string()
  .regex(DELIVERY_CONTRACT_ID_PATTERN, 'must match <name>@<version>, e.g. runnable-prototype@1');

/**
 * Validates exactly the frozen declaration field set (FR-1): `id`, `name`, `version`,
 * `target_type`, `requires`, and `verification`. No conditional, script, expression, or
 * extension field is permitted (`.strict()`).
 */
export const deliveryContractDeclarationSchema = z
  .object({
    id: deliveryContractIdSchema,
    name: nonEmptyString,
    version: z.number().int().positive(),
    target_type: nonEmptyString,
    requires: z.array(z.string()),
    verification: z.array(z.string()),
  })
  .strict();
export type DeliveryContractDeclarationInput = z.infer<typeof deliveryContractDeclarationSchema>;

export const deliveryContractGetInputSchema = z.object({ id: deliveryContractIdSchema }).strict();
export type DeliveryContractGetInput = z.infer<typeof deliveryContractGetInputSchema>;

export const deliveryContractListInputSchema = z.object({}).strict();
export type DeliveryContractListInput = z.infer<typeof deliveryContractListInputSchema>;

// ---------------------------------------------------------------------------
// SPEC-007 Delivery Layer — the first Deliverable operations (Task I-3, FR-3,
// FR-4). `validation_state` is computed-only: none of these input schemas
// accepts it (`.strict()` rejects the extra field). `deliverable_validate`
// and `deliverable_deliver` (Task I-4) and `deliverable_approve` (Task I-6)
// are separate, later schemas.
// ---------------------------------------------------------------------------

export const deliverableDefineInputSchema = z
  .object({
    initiative_id: uuidSchema,
    target_type: nonEmptyString,
    delivery_contract: deliveryContractIdSchema,
  })
  .strict();
export type DeliverableDefineInput = z.infer<typeof deliverableDefineInputSchema>;

export const deliverableGetInputSchema = z.object({ uuid: uuidSchema }).strict();
export type DeliverableGetInput = z.infer<typeof deliverableGetInputSchema>;

export const deliverableListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type DeliverableListInput = z.infer<typeof deliverableListInputSchema>;

export const deliverableAttachArtifactInputSchema = z
  .object({
    deliverable_id: uuidSchema,
    artifact_id: uuidSchema,
    requirement: nonEmptyString,
  })
  .strict();
export type DeliverableAttachArtifactInput = z.infer<typeof deliverableAttachArtifactInputSchema>;

// ---------------------------------------------------------------------------
// SPEC-007 Delivery Layer — computed validation and delivery history (Task
// I-4, FR-6, FR-7). Neither input schema accepts `validation_state`
// (`.strict()` rejects the extra field) — it stays computed-only, and the
// only path that may set `human_approved` is the separate, later
// `deliverable_approve` mutation (Task I-6).
// ---------------------------------------------------------------------------

export const deliverableValidateInputSchema = z.object({ deliverable_id: uuidSchema }).strict();
export type DeliverableValidateInput = z.infer<typeof deliverableValidateInputSchema>;

export const deliverableDeliverInputSchema = z
  .object({
    deliverable_id: uuidSchema,
    delivery_reference: nonEmptyString,
  })
  .strict();
export type DeliverableDeliverInput = z.infer<typeof deliverableDeliverInputSchema>;

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
// Phase A1 — professional record and verification ledger (SPEC-002)
//
// TRANSCRIPTION, not design: validates exactly the request shapes SPEC-002
// pins in "Interfaces / contracts" and "Data model". Every scoped
// `human_key` selector pairs with its owning scope (`initiative_id`, except
// `requirement_id` for an AcceptanceCriterion) — a bare `human_key` is
// rejected, because human keys are monotonic per parent and therefore
// ambiguous across parents.
// ---------------------------------------------------------------------------

/** Exact `REQ-<n>` pattern; `<n>` is monotonic per Initiative. */
export const requirementHumanKeySchema = z.string().regex(/^REQ-\d+$/, 'must match REQ-<n>');
/** Exact `AC-<n>` pattern; `<n>` is monotonic per Requirement. */
export const acceptanceCriterionHumanKeySchema = z.string().regex(/^AC-\d+$/, 'must match AC-<n>');
/** Exact `D-<n>` pattern; `<n>` is monotonic per Initiative. */
export const decisionHumanKeySchema = z.string().regex(/^D-\d+$/, 'must match D-<n>');
/** Exact `RISK-<n>` pattern; `<n>` is monotonic per Initiative. */
export const riskHumanKeySchema = z.string().regex(/^RISK-\d+$/, 'must match RISK-<n>');

export const evidenceLinkTargetTypeSchema = z.enum([
  'requirement',
  'acceptance_criterion',
  'decision',
  'verification_run',
  'task',
]);

export const decisionCreateStatusSchema = z.enum(['open', 'decided']);
export const decisionStatusSchema = z.enum(['open', 'decided', 'superseded']);

export const riskSeveritySchema = z.enum(['low', 'medium', 'high']);
export const riskStatusValueSchema = z.enum(['open', 'mitigated', 'accepted', 'closed']);

export const verificationMethodSchema = z.enum(['command', 'agent-review', 'human']);
export const verificationStateSchema = z.enum([
  'pending',
  'pass',
  'fail',
  'blocked',
  'needs_human_review',
  'stale',
  'not_applicable',
  'superseded',
]);

// --- Requirement -----------------------------------------------------------

export const requirementAddInputSchema = z
  .object({ initiative_id: uuidSchema, statement: nonEmptyString })
  .strict();
export type RequirementAddInput = z.infer<typeof requirementAddInputSchema>;

/** `uuid` alone, or `(initiative_id, human_key)` together — never a bare `human_key` (scoped selectors, SPEC-002). */
export const requirementLookupInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    initiative_id: uuidSchema.optional(),
    human_key: requirementHumanKeySchema.optional(),
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (initiative_id and human_key) is required',
  });
export type RequirementLookupInput = z.infer<typeof requirementLookupInputSchema>;

export const requirementListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type RequirementListInput = z.infer<typeof requirementListInputSchema>;

// --- AcceptanceCriterion ----------------------------------------------------

export const acceptanceCriterionAddInputSchema = z
  .object({ requirement_id: uuidSchema, statement: nonEmptyString, check_reference: nonEmptyString })
  .strict();
export type AcceptanceCriterionAddInput = z.infer<typeof acceptanceCriterionAddInputSchema>;

/** `uuid` alone, or `(requirement_id, human_key)` together — an AcceptanceCriterion scopes to its Requirement, not its Initiative. */
export const acceptanceCriterionLookupInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    requirement_id: uuidSchema.optional(),
    human_key: acceptanceCriterionHumanKeySchema.optional(),
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.requirement_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (requirement_id and human_key) is required',
  });
export type AcceptanceCriterionLookupInput = z.infer<typeof acceptanceCriterionLookupInputSchema>;

export const acceptanceCriterionListInputSchema = z
  .object({ requirement_id: uuidSchema.optional(), initiative_id: uuidSchema.optional() })
  .strict()
  .refine((v) => (v.requirement_id !== undefined) !== (v.initiative_id !== undefined), {
    message: 'exactly one of requirement_id or initiative_id is required',
  });
export type AcceptanceCriterionListInput = z.infer<typeof acceptanceCriterionListInputSchema>;

// --- Decision ----------------------------------------------------------------

export const decisionRecordInputSchema = z
  .object({
    initiative_id: uuidSchema,
    title: nonEmptyString,
    decision: nonEmptyString,
    rationale: nonEmptyString,
    alternatives: z.array(z.string()),
    status: decisionCreateStatusSchema,
  })
  .strict();
export type DecisionRecordInput = z.infer<typeof decisionRecordInputSchema>;

/** Old-Decision identity (`uuid` or `{ initiative_id, human_key }`) plus the full new-Decision fields (FR-6). */
export const decisionSupersedeInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    initiative_id: uuidSchema.optional(),
    human_key: decisionHumanKeySchema.optional(),
    title: nonEmptyString,
    decision: nonEmptyString,
    rationale: nonEmptyString,
    alternatives: z.array(z.string()),
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (initiative_id and human_key) is required to identify the old Decision',
  });
export type DecisionSupersedeInput = z.infer<typeof decisionSupersedeInputSchema>;

export const decisionLookupInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    initiative_id: uuidSchema.optional(),
    human_key: decisionHumanKeySchema.optional(),
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (initiative_id and human_key) is required',
  });
export type DecisionLookupInput = z.infer<typeof decisionLookupInputSchema>;

export const decisionListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type DecisionListInput = z.infer<typeof decisionListInputSchema>;

// --- Evidence and EvidenceLink -----------------------------------------------

export const evidenceAddInputSchema = z
  .object({
    initiative_id: uuidSchema,
    kind: nonEmptyString,
    locator: nonEmptyString,
    /** Nullable end to end: the frozen `Evidence.content_hash` type is `string | null`. */
    content_hash: nonEmptyString.nullable(),
    summary: nonEmptyString,
  })
  .strict();
export type EvidenceAddInput = z.infer<typeof evidenceAddInputSchema>;

export const evidenceLookupInputSchema = z
  .object({ uuid: uuidSchema.optional(), initiative_id: uuidSchema.optional(), locator: nonEmptyString.optional() })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.locator !== undefined), {
    message: 'exactly one of uuid or (initiative_id and locator) is required',
  });
export type EvidenceLookupInput = z.infer<typeof evidenceLookupInputSchema>;

export const evidenceListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type EvidenceListInput = z.infer<typeof evidenceListInputSchema>;

export const evidenceLinkInputSchema = z
  .object({ evidence_id: uuidSchema, target_type: evidenceLinkTargetTypeSchema, target_id: uuidSchema })
  .strict();
export type EvidenceLinkInput = z.infer<typeof evidenceLinkInputSchema>;

export const evidenceLinksListInputSchema = z
  .object({
    evidence_id: uuidSchema.optional(),
    target_type: evidenceLinkTargetTypeSchema.optional(),
    target_id: uuidSchema.optional(),
  })
  .strict()
  .refine((v) => (v.evidence_id !== undefined) !== (v.target_type !== undefined && v.target_id !== undefined), {
    message: 'exactly one of evidence_id or (target_type and target_id) is required',
  });
export type EvidenceLinksListInput = z.infer<typeof evidenceLinksListInputSchema>;

// --- Risk ----------------------------------------------------------------------

export const riskAddInputSchema = z
  .object({
    initiative_id: uuidSchema,
    statement: nonEmptyString,
    severity: riskSeveritySchema,
    status: riskStatusValueSchema,
  })
  .strict();
export type RiskAddInput = z.infer<typeof riskAddInputSchema>;

export const riskStatusInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    initiative_id: uuidSchema.optional(),
    human_key: riskHumanKeySchema.optional(),
    status: riskStatusValueSchema,
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (initiative_id and human_key) is required',
  });
export type RiskStatusInput = z.infer<typeof riskStatusInputSchema>;

export const riskLookupInputSchema = z
  .object({
    uuid: uuidSchema.optional(),
    initiative_id: uuidSchema.optional(),
    human_key: riskHumanKeySchema.optional(),
  })
  .strict()
  .refine((v) => (v.uuid !== undefined) !== (v.initiative_id !== undefined && v.human_key !== undefined), {
    message: 'exactly one of uuid or (initiative_id and human_key) is required',
  });
export type RiskLookupInput = z.infer<typeof riskLookupInputSchema>;

export const riskListInputSchema = z.object({ initiative_id: uuidSchema }).strict();
export type RiskListInput = z.infer<typeof riskListInputSchema>;

// --- VerificationRun -------------------------------------------------------------

export const verificationRecordInputSchema = z
  .object({
    initiative_id: uuidSchema,
    acceptance_criterion_id: uuidSchema,
    method: verificationMethodSchema,
    state: verificationStateSchema,
    detail: nonEmptyString,
  })
  .strict();
export type VerificationRecordInput = z.infer<typeof verificationRecordInputSchema>;

export const verificationGetInputSchema = z.object({ uuid: uuidSchema }).strict();
export type VerificationGetInput = z.infer<typeof verificationGetInputSchema>;

export const verificationListInputSchema = z
  .object({ acceptance_criterion_id: uuidSchema.optional(), initiative_id: uuidSchema.optional() })
  .strict()
  .refine((v) => (v.acceptance_criterion_id !== undefined) !== (v.initiative_id !== undefined), {
    message: 'exactly one of acceptance_criterion_id or initiative_id is required',
  });
export type VerificationListInput = z.infer<typeof verificationListInputSchema>;

// ---------------------------------------------------------------------------
// The generic operation envelope
// ---------------------------------------------------------------------------

/**
 * The frozen Phase A0 operation set as one discriminated-union request envelope
 * (FR-3). A transport-agnostic dispatcher validates a wire body against this
 * schema and routes on `operation`.
 */
/**
 * The mutating subset of the frozen operation set as its own discriminated-union
 * request envelope. `InitiativeRecordStore.execute()` (Task I-3) validates against
 * exactly this schema — it is the sole entry point for every mutable operation, so
 * it never accepts a read-only operation shape.
 */
export const initiativeMutationRequestSchema = z.discriminatedUnion('operation', [
  mutating('product_create', productCreateInputSchema),
  mutating('workspace_create', workspaceCreateInputSchema),
  mutating('resource_register', resourceRegisterInputSchema),
  mutating('initiative_create', initiativeCreateInputSchema),
  mutating('initiative_status', initiativeStatusInputSchema),
  mutating('initiative_link_workspace', initiativeLinkWorkspaceInputSchema),
  mutating('initiative_relate', initiativeRelateInputSchema),
  mutating('initiative_task_create', initiativeTaskCreateInputSchema),
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
  mutating('initiative_task_claim', initiativeTaskClaimInputSchema),
  mutating('initiative_task_release', initiativeTaskReleaseInputSchema),
  mutating('initiative_task_complete', initiativeTaskCompleteInputSchema),
  mutating('initiative_task_execution', initiativeTaskExecutionInputSchema),
  mutating('artifact_register', artifactRegisterInputSchema),
  // Phase A1 (SPEC-002 FR-3).
  mutating('requirement_add', requirementAddInputSchema),
  mutating('acceptance_criterion_add', acceptanceCriterionAddInputSchema),
  mutating('decision_record', decisionRecordInputSchema),
  mutating('decision_supersede', decisionSupersedeInputSchema),
  mutating('evidence_add', evidenceAddInputSchema),
  mutating('evidence_link', evidenceLinkInputSchema),
  mutating('risk_add', riskAddInputSchema),
  mutating('risk_status', riskStatusInputSchema),
  mutating('verification_record', verificationRecordInputSchema),
  // SPEC-004 Lifecycle Engine (FR-2 through FR-7).
  mutating('initiative_phase_enter', initiativePhaseEnterInputSchema),
  mutating('initiative_phase_satisfy', initiativePhaseSatisfyInputSchema),
  mutating('initiative_phase_reopen', initiativePhaseReopenInputSchema),
  mutating('initiative_phase_skip', initiativePhaseSkipInputSchema),
  mutating('initiative_focus_set', initiativeFocusSetInputSchema),
  mutating('initiative_set_lifecycle_contract', initiativeSetLifecycleContractInputSchema),
  // SPEC-005 Method Registry (FR-4) — the sole Task Method mutation.
  mutating('initiative_task_set_method', initiativeTaskSetMethodInputSchema),
  // SPEC-006 Business intake (← AC-1.6) — the confirmed-draft composite mutation.
  mutating('initiative_bootstrap', initiativeBootstrapInputSchema),
  // SPEC-007 Delivery Layer (Task I-3, ← AC-1.5, AC-1.6) — the first Deliverable mutations.
  mutating('deliverable_define', deliverableDefineInputSchema),
  mutating('deliverable_attach_artifact', deliverableAttachArtifactInputSchema),
  // SPEC-007 Delivery Layer (Task I-4, ← AC-1.6, AC-1.7, AC-1.8, AC-1.9) — computed validation
  // and delivery history.
  mutating('deliverable_validate', deliverableValidateInputSchema),
  mutating('deliverable_deliver', deliverableDeliverInputSchema),
]);
export type InitiativeMutationRequest = z.infer<typeof initiativeMutationRequestSchema>;

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
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
  mutating('initiative_task_claim', initiativeTaskClaimInputSchema),
  mutating('initiative_task_release', initiativeTaskReleaseInputSchema),
  mutating('initiative_task_complete', initiativeTaskCompleteInputSchema),
  mutating('initiative_task_execution', initiativeTaskExecutionInputSchema),

  mutating('artifact_register', artifactRegisterInputSchema),
  readOnly('artifact_get', artifactGetInputSchema),

  // Phase A1 — professional record and verification ledger (SPEC-002 FR-3, FR-4).
  mutating('requirement_add', requirementAddInputSchema),
  readOnly('requirement_get', requirementLookupInputSchema),
  readOnly('requirement_list', requirementListInputSchema),

  mutating('acceptance_criterion_add', acceptanceCriterionAddInputSchema),
  readOnly('acceptance_criterion_get', acceptanceCriterionLookupInputSchema),
  readOnly('acceptance_criterion_list', acceptanceCriterionListInputSchema),

  mutating('decision_record', decisionRecordInputSchema),
  mutating('decision_supersede', decisionSupersedeInputSchema),
  readOnly('decision_get', decisionLookupInputSchema),
  readOnly('decision_list', decisionListInputSchema),

  mutating('evidence_add', evidenceAddInputSchema),
  readOnly('evidence_get', evidenceLookupInputSchema),
  readOnly('evidence_list', evidenceListInputSchema),
  mutating('evidence_link', evidenceLinkInputSchema),
  readOnly('evidence_links_list', evidenceLinksListInputSchema),

  mutating('risk_add', riskAddInputSchema),
  mutating('risk_status', riskStatusInputSchema),
  readOnly('risk_get', riskLookupInputSchema),
  readOnly('risk_list', riskListInputSchema),

  mutating('verification_record', verificationRecordInputSchema),
  readOnly('verification_get', verificationGetInputSchema),
  readOnly('verification_list', verificationListInputSchema),

  // SPEC-004 Lifecycle Engine (FR-2 through FR-9).
  mutating('initiative_phase_enter', initiativePhaseEnterInputSchema),
  mutating('initiative_phase_satisfy', initiativePhaseSatisfyInputSchema),
  mutating('initiative_phase_reopen', initiativePhaseReopenInputSchema),
  mutating('initiative_phase_skip', initiativePhaseSkipInputSchema),
  mutating('initiative_focus_set', initiativeFocusSetInputSchema),
  mutating('initiative_set_lifecycle_contract', initiativeSetLifecycleContractInputSchema),
  readOnly('initiative_gate_status', initiativeGateStatusInputSchema),

  // SPEC-005 Method Registry (FR-1 through FR-4). No caller-visible Method write operation.
  readOnly('method_get', methodGetInputSchema),
  readOnly('method_list', methodListInputSchema),
  mutating('initiative_task_set_method', initiativeTaskSetMethodInputSchema),

  // SPEC-006 Business intake (← AC-1.6) — the confirmed-draft composite mutation.
  mutating('initiative_bootstrap', initiativeBootstrapInputSchema),

  // SPEC-007 Delivery Layer — Delivery Contract registry reads (Task I-1 defined the schemas;
  // Task I-3 wires them into the shared operation union) and the first Deliverable operations
  // (Task I-3, ← AC-1.4, AC-1.5, AC-1.6).
  readOnly('delivery_contract_get', deliveryContractGetInputSchema),
  readOnly('delivery_contract_list', deliveryContractListInputSchema),
  mutating('deliverable_define', deliverableDefineInputSchema),
  readOnly('deliverable_get', deliverableGetInputSchema),
  readOnly('deliverable_list', deliverableListInputSchema),
  mutating('deliverable_attach_artifact', deliverableAttachArtifactInputSchema),
  // SPEC-007 Delivery Layer (Task I-4, ← AC-1.6, AC-1.7, AC-1.8, AC-1.9) — computed validation
  // and delivery history.
  mutating('deliverable_validate', deliverableValidateInputSchema),
  mutating('deliverable_deliver', deliverableDeliverInputSchema),
]);
export type InitiativeOperationRequest = z.infer<typeof initiativeOperationRequestSchema>;
