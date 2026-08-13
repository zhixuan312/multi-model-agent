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
/** Create-time `decision_record` status — `decision_supersede` is the only path to `'superseded'`. */
export type DecisionCreateStatus = Exclude<DecisionStatus, 'superseded'>;

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
/** Historical markers — never transition to `'superseded'` (FR-10). */
export const VERIFICATION_TERMINAL_STATES: readonly VerificationState[] = ['stale', 'not_applicable', 'superseded'];
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
    | 'VerificationRun';
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

/** The closed, typed satisfier vocabulary (FR-5) — no conditions, scripts, or runtime-extensible types. */
export type Satisfier = 'manual' | 'requirements_exist' | 'acceptance_criteria_exist' | 'decisions_settled';

/** One required gate condition inside a `LifecycleContract` phase (FR-5). */
export interface Establishment {
  /** snake_case identifier — must match `^[a-z][a-z0-9_]*$`. */
  key: string;
  satisfier: Satisfier;
}

/** One Initiative's per-phase transition record; identity is `(initiative_id, phase)` (FR-2). */
export interface PhaseRecord {
  initiative_id: string;
  phase: Phase;
  state: PhaseRecordState;
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
  | PhaseRecord;

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
  };
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
} as const;
