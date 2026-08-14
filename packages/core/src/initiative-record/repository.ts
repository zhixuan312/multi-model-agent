/**
 * Initiative Record — the repository interface and read model (Phase A0 kernel).
 *
 * `execute()` (Task I-3) is the sole entry point for every mutable operation: it
 * owns the write algorithm (validate, begin transaction, resolve idempotency,
 * check revision, enforce Product/Workspace ownership, write the record, write
 * exactly one Event, commit — SPEC-001 "Implementation details") and throws the
 * typed errors from `./errors.js` for every documented failure. One method per
 * frozen read-only operation in SPEC-001's operation table (FR-3) is added by
 * Task I-4 alongside `close()`. Read methods return the pinned public entity
 * shapes directly — there is no separate internal read representation ("read
 * model" here means these query methods, not a second schema).
 *
 * Task I-4 also adds the joined read methods `initiative_resume` (Task I-5) is
 * built from: related Initiatives, Initiative workspace links with their
 * Resources, Initiative artifacts, a bounded recent-Events window, a total
 * Event count, and Task status counts. These are plain query methods, not a
 * second `initiative_resume`-shaped operation — Task I-5 is the one place that
 * assembles `InitiativeResumeResponse` from them in one call.
 *
 * `initiativeResume` is itself one frozen operation (FR-13): a concrete
 * implementation assembles `InitiativeResumeResponse` server-side in one call: no
 * caller-visible read method decomposition is part of this contract.
 */
import type { InitiativeMutationRequest } from './schemas.js';
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Decision,
  Deliverable,
  DeliveryContract,
  DeliveryHistoryEntry,
  Evidence,
  EvidenceLink,
  EvidenceLinkTargetType,
  Initiative,
  InitiativeRecordEntity,
  InitiativeRelation,
  InitiativeStatus,
  InitiativeWorkspaceRole,
  Event,
  Product,
  Requirement,
  Resource,
  Risk,
  Task,
  TaskStatus,
  VerificationRun,
  VerificationState,
  Workspace,
} from './types.js';

/** One `initiative_relations`-joined row: the relation plus the *other* Initiative it names (Task I-5 `related_initiatives`). */
export interface RelatedInitiativeRead {
  relation: InitiativeRelation;
  initiative: Initiative;
}

/** One Initiative-Workspace link joined with its Workspace and that Workspace's Resources (Task I-5 `workspaces`). */
export interface InitiativeWorkspaceLinkRead {
  role: InitiativeWorkspaceRole;
  workspace: Workspace;
  resources: Resource[];
}

/** One Requirement joined with its ordered Acceptance Criteria (resume `requirements` — SPEC-002). */
export interface RequirementWithCriteriaRead {
  requirement: Requirement;
  acceptance_criteria: AcceptanceCriterion[];
}

/** One Acceptance Criterion's latest Verification Run (resume `verification` — SPEC-002, `latest` by `createdAt DESC, uuid DESC`). */
export interface LatestVerificationRead {
  acceptance_criterion_id: string;
  latest: VerificationRun;
}

export interface InitiativeRepository {
  /** Closes the store's own `DatabaseSync` connection. Idempotent. */
  close(): void;

  /**
   * Validates, then transactionally applies, one mutating operation request
   * (Task I-1's mutating discriminated-union subset — extended by SPEC-003
   * Phase B's `initiative_task_claim`, `initiative_task_release`,
   * `initiative_task_complete`, and `initiative_task_execution`). Synchronous:
   * the store owns a single `DatabaseSync` connection and every step —
   * idempotency lookup, revision compare, record write, Event write,
   * idempotency persist — runs inside one explicit SQLite transaction. Throws
   * a typed error from `./errors.js` for every documented failure, including
   * `task_not_claimable`, `task_claim_conflict`, and `invalid_task_transition`
   * for the Task claim/transition operations; never partially writes.
   */
  execute(request: InitiativeMutationRequest): InitiativeRecordEntity;

  /**
   * Installation-wide append-only event log, newest-last, optionally filtered
   * by `initiative_id`. Part of the repository contract because the resume
   * assembler's `events` window reads the installation-wide log (Task I-5).
   */
  listEvents(filter?: { initiative_id?: string }): Event[];

  /** `product_get` — throws `not_found` for an unknown `uuid` or `slug`. */
  getProduct(lookup: { uuid?: string; slug?: string }): Product;
  /** `product_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listProducts(): Product[];

  /** `workspace_get` — throws `not_found` for an unknown `uuid`. */
  getWorkspace(lookup: { uuid: string }): Workspace;
  /** `workspace_list` — optionally scoped to one Product; ordered `createdAt` ascending, then `uuid` ascending. */
  listWorkspaces(filter?: { product_id?: string }): Workspace[];

  /** `resource_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listResources(filter: { workspace_id: string }): Resource[];

  /** `initiative_get` — throws `not_found` for an unknown `uuid` or `human_key`. Both keys resolve the same record. */
  getInitiative(lookup: { uuid?: string; human_key?: string }): Initiative;
  /** `initiative_list` — optionally scoped by Product and/or status; ordered `createdAt` descending, then `uuid` ascending. */
  listInitiatives(filter?: { product_id?: string; status?: InitiativeStatus }): Initiative[];

  /** `initiative_relations` — relations involving the Initiative in either direction; direction is preserved (`from_id`/`to_id`). */
  listInitiativeRelations(filter: { initiative_id: string }): InitiativeRelation[];
  /** Resume join: each relation involving the Initiative paired with the *other* Initiative it names, ordered by that Initiative's `createdAt` ascending, then `uuid` ascending. */
  getRelatedInitiatives(initiativeId: string): RelatedInitiativeRead[];

  /** Resume join: the Initiative's Workspace links, each joined with its Workspace and that Workspace's Resources, ordered by Workspace `createdAt` ascending, then `uuid` ascending. */
  getInitiativeWorkspaceLinks(initiativeId: string): InitiativeWorkspaceLinkRead[];

  /** `initiative_task_get` — throws `not_found` for an unknown `uuid`. `Task.claimed_by` is `null` unless claimed (SPEC-003 Phase B). */
  getInitiativeTask(lookup: { uuid: string }): Task;
  /** `initiative_task_list` — the resume ordering: non-terminal Tasks first, then terminal Tasks; each group by `createdAt` ascending, then `uuid` ascending. */
  listInitiativeTasks(filter: { initiative_id: string }): Task[];
  /** Resume join: Task counts by status for the Initiative — every `TaskStatus` key present, defaulting to `0`. */
  countInitiativeTasksByStatus(initiativeId: string): Record<TaskStatus, number>;

  /** `artifact_get` — throws `not_found` for an unknown `uuid`. */
  getArtifact(lookup: { uuid: string }): ArtifactRef;
  /** Resume join: the Initiative's ArtifactRefs, ordered by `createdAt` ascending, then `uuid` ascending. */
  listInitiativeArtifacts(initiativeId: string): ArtifactRef[];

  /** Resume join: the newest `limit` Events for the Initiative, ordered by `event_sequence` descending. */
  listRecentEvents(filter: { initiative_id: string; limit: number }): Event[];
  /** Resume join: the total Event count for the Initiative (independent of any `event_limit` window). */
  countInitiativeEvents(initiativeId: string): number;

  // -------------------------------------------------------------------------
  // Phase A1 — professional record and verification ledger (SPEC-002 FR-4).
  // -------------------------------------------------------------------------

  /** `requirement_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getRequirement(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Requirement;
  /** `requirement_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listRequirements(filter: { initiative_id: string }): Requirement[];

  /** `acceptance_criterion_get` — `uuid`, or `(requirement_id, human_key)`. Throws `not_found`. */
  getAcceptanceCriterion(lookup: {
    uuid?: string;
    requirement_id?: string;
    human_key?: string;
  }): AcceptanceCriterion;
  /** `acceptance_criterion_list` — scoped to one Requirement or Initiative; ordered `createdAt` ascending, then `uuid` ascending. */
  listAcceptanceCriteria(filter: { requirement_id?: string; initiative_id?: string }): AcceptanceCriterion[];

  /** `decision_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getDecision(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Decision;
  /** `decision_list` — sorted by status group `'open'`, then `'decided'`, then `'superseded'`; within a group, `createdAt` ascending, then `uuid` ascending. Identical to the resume ordering. */
  listDecisions(filter: { initiative_id: string }): Decision[];

  /** `evidence_get` — `uuid`, or `(initiative_id, locator)`. Throws `not_found`. */
  getEvidence(lookup: { uuid?: string; initiative_id?: string; locator?: string }): Evidence;
  /** `evidence_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listEvidence(filter: { initiative_id: string }): Evidence[];
  /** `evidence_links_list` — scoped to one Evidence or one link target; ordered `createdAt` ascending, then `evidence_id` ascending, `target_type` ascending, `target_id` ascending (EvidenceLink's composite identity is the tie-breaker). */
  listEvidenceLinks(filter: {
    evidence_id?: string;
    target_type?: EvidenceLinkTargetType;
    target_id?: string;
  }): EvidenceLink[];

  /** `risk_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getRisk(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Risk;
  /** `risk_list` — ordered `createdAt` ascending, then `uuid` ascending (the plain list order — distinct from the resume-specific risk ordering below). */
  listRisks(filter: { initiative_id: string }): Risk[];

  /** `verification_get` — `uuid`. Throws `not_found`. */
  getVerificationRun(lookup: { uuid: string }): VerificationRun;
  /**
   * `verification_list` — for an `initiative_id` selector: `acceptance_criterion_id` ascending, then
   * `createdAt` descending, then `uuid` descending. For an `acceptance_criterion_id` selector: `createdAt`
   * descending, then `uuid` descending.
   */
  listVerificationRuns(filter: { acceptance_criterion_id?: string; initiative_id?: string }): VerificationRun[];

  /** Resume join: every Requirement for the Initiative, each with its ordered Acceptance Criteria (Requirement order, then the same order per Acceptance Criteria array). */
  getRequirementsWithCriteria(initiativeId: string): RequirementWithCriteriaRead[];
  /** Resume join: Risks ordered open-first, severity high to low, then all other statuses; within each group, `createdAt` ascending, then `uuid` ascending. Distinct from `listRisks`. */
  getResumeRisks(initiativeId: string): Risk[];
  /** Resume join: one entry per Acceptance Criterion (within the Requirements-then-Acceptance-Criteria order) that has any Verification Run, with `latest` selected by `createdAt` descending, then `uuid` descending. */
  getLatestVerificationRuns(initiativeId: string): LatestVerificationRead[];

  /** Resume count: total Requirements for the Initiative. */
  countRequirements(initiativeId: string): number;
  /** Resume count: total Acceptance Criteria across the Initiative's Requirements. */
  countAcceptanceCriteria(initiativeId: string): number;
  /** Resume count: Decisions with `status: 'open'`. */
  countOpenDecisions(initiativeId: string): number;
  /** Resume count: Risks with `status: 'open'`. */
  countOpenRisks(initiativeId: string): number;
  /** Resume count: total Evidence for the Initiative. */
  countEvidence(initiativeId: string): number;
  /** Resume count: Verification Run counts by state — every `VerificationState` key present, defaulting to `0`. */
  countVerificationByState(initiativeId: string): Record<VerificationState, number>;

  // -------------------------------------------------------------------------
  // SPEC-007 Delivery Layer — Delivery Contract registry reads (Task I-1,
  // FR-1). Immutable, seeded-only catalog; no register/update/delete method
  // exists here or anywhere in this codebase.
  // -------------------------------------------------------------------------

  /** `delivery_contract_get` — throws `unknown_delivery_contract` for an unregistered identifier. */
  getDeliveryContract(lookup: { id: string }): DeliveryContract;
  /** `delivery_contract_list` — every registered declaration, in stable ascending identifier order. */
  listDeliveryContracts(): DeliveryContract[];

  // -------------------------------------------------------------------------
  // SPEC-007 Delivery Layer — the first Deliverable reads (Task I-3, ← AC-1.4,
  // AC-1.5, AC-1.6).
  // -------------------------------------------------------------------------

  /** `deliverable_get` — throws `not_found` for an unknown `uuid`. */
  getDeliverable(lookup: { uuid: string }): Deliverable;
  /** `deliverable_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listDeliverables(filter: { initiative_id: string }): Deliverable[];

  // -------------------------------------------------------------------------
  // SPEC-007 Delivery Layer — computed validation and delivery history (Task
  // I-4, ← AC-1.8). `deliverable_validate` and `deliverable_deliver` are
  // dispatched through `execute()`, like every other mutation; this is the
  // one plain read method they add.
  // -------------------------------------------------------------------------

  /** Every immutable `DeliveryHistoryEntry` for a Deliverable, insertion-ordered. Never updated or deleted. */
  listDeliveryHistory(filter: { deliverable_id: string }): DeliveryHistoryEntry[];
}
