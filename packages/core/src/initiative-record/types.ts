/**
 * Initiative Record — frozen domain types (Phase A0 kernel).
 *
 * TRANSCRIPTION, not design: every shape here is frozen by
 * `.mma/specs/2026-08-12-mma-next-initiative-engine.md` (SPEC-001, version 4),
 * "Data model" and "Interfaces / contracts" sections. Do not add fields, widen
 * enums, or add operations beyond what that specification pins for Phase A0 —
 * later phases (SPEC-002 through SPEC-011) own that work.
 *
 * Public timestamps (`createdAt`, `updatedAt`, `timestamp`) are RFC 3339 UTC
 * strings. `revision` is a non-negative integer. A `null` value is returned
 * explicitly wherever a shape permits `null`.
 */

/** `human`, `agent`, or `system` — who initiated a mutation. */
export type ActorType = 'human' | 'agent' | 'system';

/** Every mutation's required provenance record (frozen field set — FR-9). */
export interface Provenance {
  actor_type: ActorType;
  actor_id: string;
  interface: string;
  initiated_by: string;
  authorized_by: string;
  /** RFC 3339 UTC timestamp. */
  timestamp: string;
  source: string;
}

/** The common control envelope every mutating operation carries (FR-7, FR-8, FR-9). */
export interface MutationControl {
  expected_revision: number;
  idempotency_key?: string;
  provenance: Provenance;
}

export type InitiativeStatus = 'open' | 'closed';
export type InitiativeOutcome =
  | 'delivered'
  | 'cancelled'
  | 'abandoned'
  | 'superseded'
  | 'closed_with_concerns'
  | null;

export type InitiativeWorkspaceRole =
  | 'consumes'
  | 'references'
  | 'modifies'
  | 'creates'
  | 'delivers_to';

export type InitiativeRelationType = 'depends_on' | 'blocks' | 'supersedes' | 'related_to';

export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskOutcome = 'succeeded' | 'succeeded_with_concerns' | 'failed' | 'not_completed' | null;

/** Non-terminal vs. terminal Task statuses (used by the resume ordering rule). */
export const NON_TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['open', 'claimed', 'in_progress', 'blocked'];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];

export type ArtifactStorageMode = 'managed' | 'external';

export interface Product {
  uuid: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Workspace {
  uuid: string;
  product_id: string;
  name: string;
  slug: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Resource {
  uuid: string;
  workspace_id: string;
  type: string;
  canonical_locator: string;
  local_path: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Initiative {
  uuid: string;
  /** Exact `MMA-INIT-<n>` pattern; `<n>` is monotonic per installation (FR-6). */
  human_key: string;
  product_id: string;
  title: string;
  goal: string;
  status: InitiativeStatus;
  outcome: InitiativeOutcome;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Additive (SPEC-004 Lifecycle Engine, schema v4). `null` for every pre-v4 Initiative and for a new Initiative before `initiative_focus_set`. */
  focus_phase: Phase | null;
  /** Additive (SPEC-004 Lifecycle Engine, schema v4). `null` means no Lifecycle Contract applies (gates read green). New Initiatives default to `'default-sdl@1'` unless `initiative_create.lifecycle_contract` overrides it. */
  lifecycle_contract: string | null;
}

/** Composite identity: `(initiative_id, workspace_id, role)`. */
export interface InitiativeWorkspaceLink {
  initiative_id: string;
  workspace_id: string;
  role: InitiativeWorkspaceRole;
  createdAt: string;
  revision: number;
}

/** Composite identity: `(from_id, to_id, type)`. */
export interface InitiativeRelation {
  from_id: string;
  to_id: string;
  type: InitiativeRelationType;
  createdAt: string;
  revision: number;
}

export interface Task {
  uuid: string;
  initiative_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  outcome: TaskOutcome;
  /**
   * NEW in SPEC-003 Phase B: the claimant's `provenance.actor_id`, or `null`
   * when unclaimed. `initiative_task_claim` sets it; `initiative_task_release`
   * resets it to `null`; `initiative_task_complete` leaves it unchanged. Tasks
   * created before schema version 3, and every unclaimed Task, read `null`.
   */
  claimed_by: string | null;
  workspace_ids: string[];
  resource_ids: string[];
  /** Optional on input; `[]` when omitted. Free-form — no foreign key into `executions.db`. */
  executionRefs: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Additive (SPEC-005 Method Registry, schema v5). `null` for every pre-v5 Task and for a new Task that omits `method`. A non-null value is a registered Method identifier. */
  method: string | null;
}

/** Composite identity: `(initiative_id, path_or_uri)` — the sole Phase A0 create-or-update key. */
export interface ArtifactRef {
  uuid: string;
  initiative_id: string;
  storage_mode: ArtifactStorageMode;
  path_or_uri: string;
  content_hash: string | null;
  media_type: string | null;
  version: string | null;
  produced_by_task: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

// ---------------------------------------------------------------------------
// Phase A1 — professional record and verification ledger
//
// TRANSCRIPTION, not design: every shape below is frozen by
// `.mma/specs/2026-08-13-spec-002-professional-record.md` (SPEC-002, version 4),
// "Data model" and "Interfaces / contracts" sections. Every Phase A1 record uses
// a UUID identity, except EvidenceLink, whose identity is the composite
// `(evidence_id, target_type, target_id)`.
// ---------------------------------------------------------------------------

export type DecisionStatus = 'open' | 'decided' | 'superseded';

export type EvidenceLinkTargetType =
  | 'requirement'
  | 'acceptance_criterion'
  | 'decision'
  | 'verification_run'
  | 'task';

export type RiskSeverity = 'low' | 'medium' | 'high';
export type RiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';

export type VerificationMethod = 'command' | 'agent-review' | 'human';
export type VerificationState =
  | 'pending'
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'needs_human_review'
  | 'stale'
  | 'not_applicable'
  | 'superseded';

/** Non-terminal states eligible for automatic `'superseded'` transition when a newer run lands (FR-10). */
export const VERIFICATION_NON_TERMINAL_STATES: readonly VerificationState[] = [
  'pending',
  'pass',
  'fail',
  'blocked',
  'needs_human_review',
];
/** States eligible for stale-evidence propagation (FR-11). */
export const VERIFICATION_STALE_ELIGIBLE_STATES: readonly VerificationState[] = ['pass', 'fail'];
/** Every VerificationRun state, in a stable order — the `verification_by_state` count keys (FR-12). */
export const VERIFICATION_STATES: readonly VerificationState[] = [
  'pending',
  'pass',
  'fail',
  'blocked',
  'needs_human_review',
  'stale',
  'not_applicable',
  'superseded',
];

export interface Requirement {
  uuid: string;
  initiative_id: string;
  /** Exact `REQ-<n>` pattern; `<n>` is monotonic per Initiative. */
  human_key: string;
  statement: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AcceptanceCriterion {
  uuid: string;
  requirement_id: string;
  /** Exact `AC-<n>` pattern; `<n>` is monotonic per Requirement. */
  human_key: string;
  statement: string;
  /** Free prose naming a reference or method — not an executable command. */
  check_reference: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Decision {
  uuid: string;
  initiative_id: string;
  /** Exact `D-<n>` pattern; `<n>` is monotonic per Initiative. */
  human_key: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  status: DecisionStatus;
  superseded_by: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** Create-or-update identity: `(initiative_id, locator)` (FR-7). */
export interface Evidence {
  uuid: string;
  initiative_id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** The sole Phase A1 record identified by its composite identity, not a UUID: `(evidence_id, target_type, target_id)`. */
export interface EvidenceLink {
  evidence_id: string;
  target_type: EvidenceLinkTargetType;
  target_id: string;
  createdAt: string;
  revision: number;
}

export interface Risk {
  uuid: string;
  initiative_id: string;
  /** Exact `RISK-<n>` pattern; `<n>` is monotonic per Initiative. */
  human_key: string;
  statement: string;
  severity: RiskSeverity;
  status: RiskStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** Immutable once created; the only permitted transitions are system-driven `'stale'` and `'superseded'` (FR-10, FR-11). */
export interface VerificationRun {
  uuid: string;
  initiative_id: string;
  acceptance_criterion_id: string;
  method: VerificationMethod;
  state: VerificationState;
  detail: string;
  createdAt: string;
  revision: number;
}

/** Append-only; no update or delete path. `event_sequence` is monotonic per installation. */
export interface Event {
  event_sequence: number;
  entity_type:
    | 'Product'
    | 'Workspace'
    | 'Resource'
    | 'Initiative'
    | 'InitiativeWorkspaceLink'
    | 'InitiativeRelation'
    | 'Task'
    | 'ArtifactRef'
    | 'Requirement'
    | 'AcceptanceCriterion'
    | 'Decision'
    | 'Evidence'
    | 'EvidenceLink'
    | 'Risk'
    | 'VerificationRun'
    | 'Deliverable'
    | 'DeliverableArtifactMember';
  entity_id: string;
  initiative_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  actor_type: ActorType;
  actor_id: string;
  interface: string;
  initiated_by: string;
  authorized_by: string;
  timestamp: string;
  source: string;
}

// ---------------------------------------------------------------------------
// SPEC-004 Lifecycle Engine
//
// TRANSCRIPTION, not design: every shape below is frozen by
// `.mma/specs/2026-08-13-spec-004-lifecycle-engine.md` (SPEC-004, "Interfaces
// / contracts" and "Data model"). The engine records phase transitions and
// evaluates advisory gates against the live record; it never enforces a
// transition, gate colour, or workflow order on a caller (FR-1, FR-8).
// ---------------------------------------------------------------------------

/** The six frozen SDLC phases, in their canonical (and only legal `LifecycleResumeBlock.phases`) order. */
export type Phase = 'discover' | 'refine' | 'design' | 'execute' | 'verify' | 'deliver';

/** Canonical phase order — the exact order `LifecycleResumeBlock.phases` must use (FR-1, FR-13). */
export const LIFECYCLE_PHASES: readonly Phase[] = ['discover', 'refine', 'design', 'execute', 'verify', 'deliver'];

/**
 * The seeded, immutable built-in Lifecycle Contract id (FR-5, FR-6). The v4 migration seeds its
 * row; `initiative_create` defaults a new Initiative's `lifecycle_contract` to this id when the
 * caller omits it (FR-7). Single source of truth so the migration and the store never drift.
 */
export const DEFAULT_LIFECYCLE_CONTRACT_ID = 'default-sdl@1' as const;

/** A Phase Record's state machine (FR-2). Absent rows synthesize to `'not_started'`. */
export type PhaseRecordState = 'not_started' | 'active' | 'satisfied' | 'reopened' | 'skipped';

/**
 * The closed, typed satisfier vocabulary (FR-5) — no conditions, scripts, or runtime-extensible
 * types. `deliverables_valid` is SPEC-007's Delivery Layer addition (Task I-7, ← AC-1.11): true
 * only when every Deliverable of the Initiative is `valid` or `human_approved` (vacuously true
 * with no Deliverables).
 */
export type Satisfier =
  | 'manual'
  | 'requirements_exist'
  | 'acceptance_criteria_exist'
  | 'decisions_settled'
  | 'deliverables_valid';

/** One required gate condition inside a `LifecycleContract` phase (FR-5). */
export interface Establishment {
  /** snake_case identifier — must match `^[a-z][a-z0-9_]*$`. */
  key: string;
  satisfier: Satisfier;
}

/**
 * One Initiative's per-phase transition record; identity is `(initiative_id, phase)` (FR-2).
 * `revision` is the owning Initiative's new revision after this mutation (not a revision of the
 * Phase Record itself, which carries none) — every phase mutation requires `expected_revision`,
 * so this lets a caller chain the next transition without an intervening `initiative_get`/
 * `initiative_resume` read, the same way `initiative_focus_set` already returns the full,
 * freshly-revisioned Initiative.
 */
export interface PhaseRecord {
  initiative_id: string;
  phase: Phase;
  state: PhaseRecordState;
  revision: number;
}

/** A versioned, immutable Lifecycle Contract (FR-5). `id` matches `^[a-z][a-z0-9-]*@[1-9][0-9]*$`. */
export interface LifecycleContract {
  id: string;
  phases: Record<Phase, { required: Establishment[] }>;
}

/** One Establishment's live gate evaluation result (FR-8). */
export interface GateEstablishmentResult {
  establishment: Establishment;
  satisfied: boolean;
  detail: string;
}

/** A phase's live, advisory, never-persisted gate result (FR-8). */
export interface GateStatus {
  status: 'green' | 'red';
  /** Every required Establishment with its verdict (FR-8), satisfied and unsatisfied alike. */
  establishments: GateEstablishmentResult[];
  /** The unsatisfied subset of `establishments` — what still stands between here and green. */
  missing: GateEstablishmentResult[];
  note?: string;
}

/** The additive `initiative_resume`/`initiative_gate_status` lifecycle block (FR-9, FR-13). */
export interface LifecycleResumeBlock {
  focus_phase: Phase | null;
  contract: string | null;
  /** Exactly six entries, in `LIFECYCLE_PHASES` order. */
  phases: Array<{ phase: Phase; state: PhaseRecordState; gate: GateStatus }>;
  recent_lifecycle_events: Event[];
}

// ---------------------------------------------------------------------------
// SPEC-005 Method Registry
//
// TRANSCRIPTION, not design: every shape below is frozen by
// `.mma/specs/2026-08-13-spec-005-method-registry.md` (SPEC-005, "Data
// model" and "Interfaces / contracts"). A Method is the registered,
// immutable definition of how a class of professional work is performed
// (FR-1 through FR-4). The registry exposes no caller-visible write
// operation — only the nine seeded built-in declarations ever exist.
// ---------------------------------------------------------------------------

/** A Method identifier: `<name>@<version>`, version >= 1, no leading zero (FR-2). */
export const METHOD_ID_PATTERN = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

/**
 * A registered, immutable Method declaration (FR-2, FR-3). Exactly these seven fields — no
 * conditional, script, expression, or runtime-extensible field. Procedure prose lives in the
 * committed guidance asset, not this declaration.
 */
export interface MethodDeclaration {
  id: string;
  name: string;
  version: number;
  purpose: string;
  required_inputs: string[];
  expected_outputs: string[];
  verification_expectations: string[];
}

// ---------------------------------------------------------------------------
// SPEC-007 Delivery Layer — Delivery Contract registry (Task I-1)
//
// TRANSCRIPTION, not design: frozen by
// `.mma/specs/2026-08-14-spec-007-delivery-layer.md` (SPEC-007, "Interfaces /
// contracts" and "Data model"). A Delivery Contract is the immutable
// declaration of the required bundle items and verification expectations for
// one kind of Deliverable. The registry exposes no caller-visible write
// operation — only the two seeded built-in declarations ever exist.
// ---------------------------------------------------------------------------

/** A Delivery Contract identifier: `<name>@<version>`, version >= 1, no leading zero (FR-1). */
export const DELIVERY_CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

/**
 * A registered, immutable Delivery Contract declaration (FR-1, FR-2). Exactly these six
 * fields — no conditional, script, expression, or runtime-extensible field.
 */
export interface DeliveryContract {
  id: string;
  name: string;
  version: number;
  target_type: string;
  requires: string[];
  verification: string[];
}

// ---------------------------------------------------------------------------
// SPEC-007 Delivery Layer — generic adapter interface (Task I-2)
//
// TRANSCRIPTION, not design: frozen by
// `.mma/specs/2026-08-14-spec-007-delivery-layer.md` (SPEC-007, "Interfaces /
// contracts"). These are the FULL public Deliverable, membership, and
// history shapes the frozen `TargetAdapter.validate` signature names —
// declared here (Task I-2) so the interface type-checks; the store methods,
// operations, and persistence that populate and mutate them are Task I-3
// (Deliverable + membership) and Task I-4 (validation + delivery history).
// Declaring the shape here is not "implementing" those later tasks' scope:
// no store method, operation, schema, or migration touches these two tables'
// rows in this task.
// ---------------------------------------------------------------------------

/** The closed Deliverable validation-state vocabulary (FR-3, FR-6). */
export type DeliverableValidationState = 'pending' | 'valid' | 'invalid' | 'human_approved';
/** Every `DeliverableValidationState`, in a stable order — the `deliverables_by_validation_state` count keys. */
export const DELIVERABLE_VALIDATION_STATES: readonly DeliverableValidationState[] = [
  'pending',
  'valid',
  'invalid',
  'human_approved',
];

/** A target-ready bundle of Artifacts (FR-3). Task I-3 adds the store methods that create and read these rows. */
export interface Deliverable {
  uuid: string;
  initiative_id: string;
  target_type: string;
  delivery_contract: string;
  validation_state: DeliverableValidationState;
  validation_detail: string;
  delivery_reference: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** One Deliverable-to-Artifact membership row, naming the contract `requires` entry it satisfies (FR-4). */
export interface DeliverableArtifactMember {
  deliverable_id: string;
  artifact_id: string;
  requirement: string;
  createdAt: string;
}

/** One immutable, append-only delivery history row (FR-7). Task I-4 adds the store method that appends these. */
export interface DeliveryHistoryEntry {
  uuid: string;
  deliverable_id: string;
  delivery_reference: string;
  validation_state: DeliverableValidationState;
  createdAt: string;
}

/**
 * The public extension contract (FR-8). `validate` receives a generic Deliverable, its
 * resolved Delivery Contract, and its joined membership — never a target-specific shape.
 * Core defines this interface and the registry below; core registers no adapter and this
 * module names no shipped or fake target (Task I-5 proves that boundary with a source scan).
 */
export interface TargetAdapter {
  target_type: string;
  validate(input: {
    deliverable: Deliverable;
    contract: DeliveryContract;
    members: Array<{ member: DeliverableArtifactMember; artifact: ArtifactRef }>;
  }): { valid: boolean; detail: string };
}

// ---------------------------------------------------------------------------
// MMA Next gap-closure — verification execution, packaging assembly, and
// Initiative portability (`.mma/specs/2026-08-12-mma-next-initiative-engine.md`
// §15 application surface, §21 success criterion 12). All four additions
// below are additive to the Initiative Record: no existing field, operation,
// or event mapping is renamed, widened, or removed.
// ---------------------------------------------------------------------------

/** One `deliverable_package` coverage entry: a Delivery Contract `requires` string, and the
 *  member Artifacts currently attached under it (empty when the requirement is uncovered). */
export interface DeliverablePackageCoverage {
  requirement: string;
  members: Array<{ artifact_id: string; path_or_uri: string }>;
}

/**
 * `deliverable_package` result shape: the root object IS the (revision-bumped) Deliverable —
 * the same "root IS the entity, plus more" convention `InitiativeBootstrapResult` established —
 * plus the computed packaging report. Contract-completeness only: this operation never resolves
 * or calls a `TargetAdapter` and never invents file content; the committed packager guidance
 * (`loadDeliveryPackager`) supplies the "how to package" prose, and target specifics live
 * exclusively in adapters (SPEC-007 FR-8's boundary, unchanged by this addition).
 */
export interface DeliverablePackageResult extends Deliverable {
  coverage: DeliverablePackageCoverage[];
  /** Delivery Contract `requires` entries with zero covering members. */
  missing: string[];
  /** `true` only when `missing` is empty. Incomplete membership is reported, not rejected. */
  complete: boolean;
  /** The committed packager asset's Markdown text for this Deliverable's `delivery_contract`. */
  packaging_guidance: string;
}

/** The public result shape returned by every mutating operation (Task I-3 `execute()`). */
export type InitiativeRecordEntity =
  | Product
  | Workspace
  | Resource
  | Initiative
  | InitiativeWorkspaceLink
  | InitiativeRelation
  | Task
  | ArtifactRef
  | Requirement
  | AcceptanceCriterion
  | Decision
  | Evidence
  | EvidenceLink
  | Risk
  | VerificationRun
  | PhaseRecord
  | InitiativeBootstrapResult
  | Deliverable
  | DeliverableArtifactMember
  | DeliverablePackageResult;

/** One `initiative_bootstrap` requested Workspace, paired back to its request `workspace_key`. */
export interface InitiativeBootstrapWorkspaceResult extends Workspace {
  workspace_key: string;
  role: InitiativeWorkspaceRole;
}

/** One `initiative_bootstrap` created Resource, paired back to its request `workspace_key`. */
export interface InitiativeBootstrapResourceResult extends Resource {
  workspace_key: string;
}

/** One `initiative_bootstrap` created Requirement, with its nested Acceptance Criteria. */
export interface InitiativeBootstrapRequirementResult extends Requirement {
  acceptance_criteria: AcceptanceCriterion[];
}

/**
 * `initiative_bootstrap` result shape (SPEC-006, ← AC-1.4, AC-1.6). Task I-2 sketched this type
 * as a nested envelope; Task I-3 (the task that "makes the store return it") settles the shape
 * its own acceptance test pins: the root object IS the created Initiative (spreading every
 * `Initiative` field, including `uuid`, at the top level — not nested under `.initiative`),
 * alongside the resolved Product, the requested Workspaces (each paired back to its request
 * `workspace_key`), created Resources (same pairing), the Initiative-to-Workspace links, and the
 * Requirements with their nested Acceptance Criteria.
 */
export interface InitiativeBootstrapResult extends Initiative {
  product: Product;
  workspaces: InitiativeBootstrapWorkspaceResult[];
  resources: InitiativeBootstrapResourceResult[];
  initiative_workspace_links: InitiativeWorkspaceLink[];
  requirements: InitiativeBootstrapRequirementResult[];
}

/** `initiative_resume` request — exactly one of `uuid` or `human_key`. */
export interface InitiativeResumeRequest {
  initiative: { uuid?: string; human_key?: string };
  /** Integer; default 20; valid range 1 through 100. */
  event_limit?: number;
}

/** `initiative_resume` response — the complete pinned continuation payload (FR-13, extended by SPEC-002 FR-12). */
export interface InitiativeResumeResponse {
  initiative: Initiative;
  product: Product;
  workspaces: Array<{ role: InitiativeWorkspaceRole; workspace: Workspace; resources: Resource[] }>;
  related_initiatives: Array<{ relation: InitiativeRelation; initiative: Initiative }>;
  tasks: Task[];
  artifacts: ArtifactRef[];
  events: Event[];
  /** Phase A1: each Requirement with its ordered Acceptance Criteria. */
  requirements: Array<{ requirement: Requirement; acceptance_criteria: AcceptanceCriterion[] }>;
  /** Phase A1: ordered `'open'`, then `'decided'`, then `'superseded'`. */
  decisions: Decision[];
  /** Phase A1: open Risks first (severity high to low), then all other statuses. */
  risks: Risk[];
  /** Phase A1: ordered `createdAt ASC, uuid ASC`. EvidenceLinks are deliberately NOT included here. */
  evidence: Evidence[];
  /** Phase A1: one entry per Acceptance Criterion with any run, `latest` by `createdAt DESC, uuid DESC`. */
  verification: Array<{ acceptance_criterion_id: string; latest: VerificationRun }>;
  /** SPEC-004: additive lifecycle block — focus phase, contract, six phase/gate entries, and recent lifecycle Events. */
  lifecycle: LifecycleResumeBlock;
  /**
   * MMA Next gap-closure (§15, "resume returns deliverable validation states"): every
   * Deliverable defined under the Initiative, each with its target_type, delivery_contract,
   * validation_state, validation_detail, and delivery_reference — ordered `createdAt` ascending,
   * then `uuid` ascending (the same order `deliverable_list` uses). Additive: `[]` for an
   * Initiative with no Deliverables.
   */
  deliverables: Deliverable[];
  counts: {
    workspaces: number;
    resources: number;
    related_initiatives: number;
    tasks: number;
    tasks_by_status: Record<TaskStatus, number>;
    artifacts: number;
    events_returned: number;
    events_total: number;
    /** Phase A1 counts (FR-12). */
    requirements: number;
    acceptance_criteria: number;
    decisions_open: number;
    risks_open: number;
    evidence: number;
    verification_by_state: Record<VerificationState, number>;
    /** MMA Next gap-closure: Deliverable counts by validation_state — every `DeliverableValidationState` key present, defaulting to `0`, matching how `verification_by_state` already works. */
    deliverables_by_validation_state: Record<DeliverableValidationState, number>;
  };
}

/**
 * `initiative_export`/`initiative_import`'s schema-version stamp (MMA Next §15, §21 success
 * criterion 12: "an Initiative can be exported to a portable snapshot and re-imported"). Bumped
 * only when the portable snapshot shape changes; `initiative_import` rejects a snapshot whose
 * `schema_version` this build does not recognize.
 */
export const INITIATIVE_EXPORT_SCHEMA_VERSION = 1;

/** One exported Initiative-Workspace link: the link's own row (role, createdAt, revision) plus the joined Workspace and its Resources. */
export interface ExportedWorkspaceLink {
  link: InitiativeWorkspaceLink;
  workspace: Workspace;
  resources: Resource[];
}

/** One exported Phase Record. Only phases with a persisted row are included — an absent phase
 *  synthesizes to `not_started` on read either way, so a snapshot with no lifecycle activity
 *  carries `[]` here rather than fabricating six default rows. */
export interface ExportedPhaseRecord {
  phase: Phase;
  state: PhaseRecordState;
}

/** One exported Deliverable, with its full membership and delivery history. */
export interface ExportedDeliverableBundle {
  deliverable: Deliverable;
  members: DeliverableArtifactMember[];
  history: DeliveryHistoryEntry[];
}

/**
 * `initiative_export`'s complete, self-contained portable snapshot of ONE Initiative (MMA Next
 * §15, §21 success criterion 12). Additive-only public shape: a future `schema_version` bump
 * adds fields rather than reshaping these.
 *
 * EvidenceLinks are deliberately NOT included — the same choice `InitiativeResumeResponse`
 * already documents for its own `evidence` section. Methods, Delivery Contracts, and Lifecycle
 * Contracts are not included either: every Initiative Record store seeds the same immutable
 * built-in catalogs on open (`migrations.ts`) and there is no caller-visible registration path
 * for any of the three, so every id an imported record references already resolves in the
 * target store. InitiativeRelations (to OTHER Initiatives) are out of scope too — a
 * single-Initiative snapshot cannot portably carry a relation to an Initiative it does not also
 * contain.
 */
export interface InitiativeExportSnapshot {
  schema_version: number;
  /** RFC 3339 UTC timestamp of when this snapshot was assembled. */
  exported_at: string;
  initiative: Initiative;
  product: Product;
  workspaces: ExportedWorkspaceLink[];
  tasks: Task[];
  artifacts: ArtifactRef[];
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriterion[];
  decisions: Decision[];
  evidence: Evidence[];
  risks: Risk[];
  verification_runs: VerificationRun[];
  phase_records: ExportedPhaseRecord[];
  deliverables: ExportedDeliverableBundle[];
  /** Every Event carrying this Initiative's `initiative_id`, ascending by `event_sequence`. */
  events: Event[];
}

/** The frozen Phase A0 operation set (FR-3), extended by the Phase A1 operation set (SPEC-002 FR-3, FR-4). */
export const INITIATIVE_OPERATIONS = [
  'product_create',
  'product_get',
  'product_list',
  'workspace_create',
  'workspace_get',
  'workspace_list',
  'resource_register',
  'resource_list',
  'initiative_create',
  'initiative_get',
  'initiative_list',
  'initiative_status',
  'initiative_resume',
  'initiative_link_workspace',
  'initiative_relate',
  'initiative_relations',
  'initiative_task_create',
  'initiative_task_get',
  'initiative_task_list',
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
  'initiative_task_claim',
  'initiative_task_release',
  'initiative_task_complete',
  'initiative_task_execution',
  'artifact_register',
  'artifact_get',
  // Phase A1 — professional record and verification ledger (SPEC-002).
  'requirement_add',
  'requirement_get',
  'requirement_list',
  'acceptance_criterion_add',
  'acceptance_criterion_get',
  'acceptance_criterion_list',
  'decision_record',
  'decision_supersede',
  'decision_get',
  'decision_list',
  'evidence_add',
  'evidence_get',
  'evidence_list',
  'evidence_link',
  'evidence_links_list',
  'risk_add',
  'risk_status',
  'risk_get',
  'risk_list',
  'verification_record',
  'verification_get',
  'verification_list',
  // SPEC-004 Lifecycle Engine — phase/focus mutations, contract reference, and the advisory gate read (FR-2 through FR-9).
  'initiative_phase_enter',
  'initiative_phase_satisfy',
  'initiative_phase_reopen',
  'initiative_phase_skip',
  'initiative_focus_set',
  'initiative_set_lifecycle_contract',
  'initiative_gate_status',
  // SPEC-005 Method Registry — registered reads and the sole Task Method mutation (FR-1
  // through FR-4). No caller-visible Method write operation exists.
  'method_get',
  'method_list',
  'initiative_task_set_method',
  // SPEC-006 Business intake — the confirmed-draft composite mutation (FR-6, ← AC-1.6). Task
  // I-2 defines the contract only; Task I-3 implements the store dispatch.
  'initiative_bootstrap',
  // SPEC-007 Delivery Layer — Delivery Contract registry reads (Task I-1 defined the schemas;
  // Task I-3 wires them into the shared operation union) and the first Deliverable operations
  // (Task I-3, ← AC-1.4, AC-1.5, AC-1.6). `deliverable_validate` and `deliverable_deliver`
  // (Task I-4, ← AC-1.6, AC-1.7, AC-1.8, AC-1.9) complete the shared operation surface;
  // `deliverable_approve` (Task I-6, ← AC-1.7) is the maintainer-confirmed sole path to the
  // human-approved validation state.
  'delivery_contract_get',
  'delivery_contract_list',
  'deliverable_define',
  'deliverable_get',
  'deliverable_list',
  'deliverable_attach_artifact',
  'deliverable_validate',
  'deliverable_deliver',
  'deliverable_approve',
  // MMA Next gap-closure (§15 application surface, §21 success criterion 12): verification
  // execution, packaging assembly, and Initiative portability. All four are additive.
  'verification_run',
  'deliverable_package',
  'initiative_export',
  'initiative_import',
] as const;

export type InitiativeOperation = (typeof INITIATIVE_OPERATIONS)[number];

/** Frozen event-type/payload mapping (Data model section) — used by tests and the write algorithm. */
export const INITIATIVE_EVENT_TYPES = {
  product_create: 'product_created',
  workspace_create: 'workspace_created',
  resource_register: 'resource_registered',
  initiative_create: 'initiative_created',
  initiative_status: 'initiative_status_changed',
  initiative_link_workspace: 'initiative_workspace_linked',
  initiative_relate: 'initiative_related',
  initiative_task_create: 'task_created',
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
  initiative_task_claim: 'task_claimed',
  initiative_task_release: 'task_released',
  initiative_task_complete: 'task_completed',
  initiative_task_execution: 'task_execution_recorded',
  artifact_register_create: 'artifact_registered',
  artifact_register_update: 'artifact_updated',
  // Phase A1 (SPEC-002 "Data model" event table).
  requirement_add: 'requirement_added',
  acceptance_criterion_add: 'acceptance_criterion_added',
  decision_record: 'decision_recorded',
  /** The old Decision's transition inside `decision_supersede`; the new Decision reuses `decision_record`'s event type. */
  decision_supersede: 'decision_superseded',
  evidence_add_create: 'evidence_added',
  evidence_add_update: 'evidence_updated',
  evidence_link: 'evidence_linked',
  risk_add: 'risk_added',
  risk_status: 'risk_status_changed',
  verification_record: 'verification_recorded',
  /** System-driven: a newer run superseded a prior non-terminal run for the same Acceptance Criterion. */
  verification_superseded: 'verification_superseded',
  /** System-driven: a linked Evidence content-hash change staled a passing or failing run. */
  verification_stale: 'verification_stale',
  // SPEC-004 Lifecycle Engine (FR-2 through FR-7, "Data model" event table). `initiative_gate_status`
  // is a read — it has no event-type mapping.
  initiative_phase_enter: 'phase_entered',
  initiative_phase_satisfy: 'phase_satisfied',
  initiative_phase_reopen: 'phase_reopened',
  initiative_phase_skip: 'phase_skipped',
  initiative_focus_set: 'focus_changed',
  initiative_set_lifecycle_contract: 'lifecycle_contract_set',
  // SPEC-005 Method Registry (FR-4, "Data model" event table). `method_get`/`method_list` are
  // reads — they have no event-type mapping.
  initiative_task_set_method: 'task_method_set',
  // SPEC-007 Delivery Layer (Task I-3, "Data model" event table). `delivery_contract_get`/
  // `delivery_contract_list`/`deliverable_get`/`deliverable_list` are reads — they have no
  // event-type mapping.
  deliverable_define: 'deliverable_defined',
  deliverable_attach_artifact: 'deliverable_artifact_attached',
  // SPEC-007 Delivery Layer (Task I-4, "Data model" event table).
  deliverable_validate: 'deliverable_validated',
  deliverable_deliver: 'deliverable_delivered',
  // SPEC-007 Delivery Layer (Task I-6, "Interfaces / contracts") — the maintainer-confirmed
  // human-approval mutation.
  deliverable_approve: 'deliverable_approved',
  // MMA Next gap-closure (§15). `initiative_export` is a read — it has no event-type mapping.
  // `initiative_import` writes many replayed Events (one per snapshot Event, faithfully
  // reconstructed) rather than one event of its own — no single mapping entry applies.
  verification_run: 'verification_run_executed',
  deliverable_package: 'deliverable_packaged',
} as const;

/**
 * Frozen Event payload keys (SPEC-002 Phase A1 "Data model" event table,
 * extended by SPEC-003 Phase B's Task claim/transition event table).
 *
 * This is intentionally a wire-contract table rather than a runtime payload
 * validator: the store owns Event construction, while consumers and contract
 * tests can share this exact approved key set without duplicating literals.
 */
export const INITIATIVE_EVENT_PAYLOAD_KEYS = {
  // SPEC-006 Business intake (← AC-1.6): the five Group 001A event types `initiative_bootstrap`
  // reuses unchanged. These key sets already match what `sqlite-store.ts`'s per-entity mutations
  // construct (Task I-3 supplementary coverage, `mutation-event-payload.test.ts`) — added here so
  // the frozen payload-key table documents every event type `initiative_bootstrap` can emit.
  product_created: ['uuid', 'slug'],
  workspace_created: ['uuid', 'product_id', 'slug'],
  resource_registered: ['uuid', 'workspace_id', 'canonical_locator'],
  initiative_created: ['uuid', 'human_key', 'product_id'],
  initiative_workspace_linked: ['initiative_id', 'workspace_id', 'role'],
  requirement_added: ['uuid', 'initiative_id', 'human_key'],
  acceptance_criterion_added: ['uuid', 'requirement_id', 'human_key'],
  decision_recorded: ['uuid', 'initiative_id', 'human_key', 'status'],
  decision_superseded: ['uuid', 'superseded_by'],
  evidence_added: ['uuid', 'initiative_id', 'locator'],
  evidence_updated: ['uuid', 'initiative_id', 'locator'],
  evidence_linked: ['evidence_id', 'target_type', 'target_id'],
  risk_added: ['uuid', 'initiative_id', 'human_key', 'severity', 'status'],
  risk_status_changed: ['uuid', 'status'],
  verification_recorded: ['uuid', 'initiative_id', 'acceptance_criterion_id', 'method', 'state'],
  verification_superseded: ['uuid', 'acceptance_criterion_id'],
  verification_stale: ['uuid', 'acceptance_criterion_id', 'evidence_uuid'],
  // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9, "Interfaces / contracts").
  task_claimed: ['uuid', 'initiative_id', 'claimed_by'],
  task_released: ['uuid', 'initiative_id'],
  task_completed: ['uuid', 'initiative_id', 'outcome'],
  task_execution_recorded: ['uuid', 'initiative_id', 'execution_ref'],
  // SPEC-004 Lifecycle Engine (FR-2 through FR-7, "Data model" event table). `gate_snapshot` is
  // mandatory on `phase_satisfied` and `focus_changed` and appears on NO other lifecycle event.
  phase_entered: ['phase', 'previous_state', 'new_state'],
  phase_satisfied: ['phase', 'previous_state', 'new_state', 'asserted', 'gate_snapshot'],
  phase_reopened: ['phase', 'previous_state', 'new_state', 'reason'],
  phase_skipped: ['phase', 'previous_state', 'new_state', 'reason'],
  focus_changed: ['phase', 'previous_focus_phase', 'new_focus_phase', 'gate_snapshot'],
  lifecycle_contract_set: ['previous_lifecycle_contract', 'new_lifecycle_contract'],
  // SPEC-005 Method Registry (FR-4, "Interfaces / contracts").
  task_method_set: ['previous_method', 'new_method'],
  // SPEC-007 Delivery Layer (Task I-3, "Interfaces / contracts").
  deliverable_defined: ['uuid', 'initiative_id', 'target_type', 'delivery_contract'],
  deliverable_artifact_attached: ['deliverable_id', 'artifact_id', 'requirement'],
  // SPEC-007 Delivery Layer (Task I-4, "Interfaces / contracts").
  deliverable_validated: ['uuid', 'validation_state', 'detail'],
  deliverable_delivered: ['uuid', 'delivery_reference', 'validation_state'],
  // SPEC-007 Delivery Layer (Task I-6, "Interfaces / contracts", maintainer-confirmed shape).
  deliverable_approved: ['uuid', 'previous_validation_state', 'new_validation_state', 'reason'],
  // MMA Next gap-closure (§15). `verification_run_executed` mirrors `verification_recorded`'s
  // key set — it persists a VerificationRun the same way, just command-executed instead of
  // caller-asserted.
  verification_run_executed: ['uuid', 'initiative_id', 'acceptance_criterion_id', 'method', 'state'],
  deliverable_packaged: ['uuid', 'delivery_contract', 'complete', 'missing'],
} as const;
