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
  ArtifactRef,
  Initiative,
  InitiativeRecordEntity,
  InitiativeRelation,
  InitiativeStatus,
  InitiativeWorkspaceRole,
  Event,
  Product,
  Resource,
  Task,
  TaskStatus,
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

export interface InitiativeRepository {
  /** Closes the store's own `DatabaseSync` connection. Idempotent. */
  close(): void;

  /**
   * Validates, then transactionally applies, one mutating operation request
   * (Task I-1's mutating discriminated-union subset). Synchronous: the store
   * owns a single `DatabaseSync` connection and every step — idempotency
   * lookup, revision compare, record write, Event write, idempotency persist —
   * runs inside one explicit SQLite transaction. Throws a typed error from
   * `./errors.js` for every documented failure; never partially writes.
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

  /** `initiative_task_get` — throws `not_found` for an unknown `uuid`. */
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
}
