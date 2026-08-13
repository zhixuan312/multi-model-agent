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
]);
export type InitiativeOperationRequest = z.infer<typeof initiativeOperationRequestSchema>;
