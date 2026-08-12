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
    | 'ArtifactRef';
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

/** The public result shape returned by every mutating operation (Task I-3 `execute()`). */
export type InitiativeRecordEntity =
  | Product
  | Workspace
  | Resource
  | Initiative
  | InitiativeWorkspaceLink
  | InitiativeRelation
  | Task
  | ArtifactRef;

/** `initiative_resume` request — exactly one of `uuid` or `human_key`. */
export interface InitiativeResumeRequest {
  initiative: { uuid?: string; human_key?: string };
  /** Integer; default 20; valid range 1 through 100. */
  event_limit?: number;
}

/** `initiative_resume` response — the complete pinned continuation payload (FR-13). */
export interface InitiativeResumeResponse {
  initiative: Initiative;
  product: Product;
  workspaces: Array<{ role: InitiativeWorkspaceRole; workspace: Workspace; resources: Resource[] }>;
  related_initiatives: Array<{ relation: InitiativeRelation; initiative: Initiative }>;
  tasks: Task[];
  artifacts: ArtifactRef[];
  events: Event[];
  counts: {
    workspaces: number;
    resources: number;
    related_initiatives: number;
    tasks: number;
    tasks_by_status: Record<TaskStatus, number>;
    artifacts: number;
    events_returned: number;
    events_total: number;
  };
}

/** The frozen Phase A0 operation set (FR-3). */
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
  'artifact_register',
  'artifact_get',
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
  artifact_register_create: 'artifact_registered',
  artifact_register_update: 'artifact_updated',
} as const;
