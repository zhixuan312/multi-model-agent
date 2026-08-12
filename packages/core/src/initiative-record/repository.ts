/**
 * Initiative Record — the repository interface and read model (Phase A0 kernel).
 *
 * One method per frozen operation in SPEC-001's operation table (FR-3), plus an
 * explicit lifecycle `close()`. This is the interface Task I-2's SQLite-backed
 * `InitiativeRecordStore` implements: it owns the write algorithm (validate,
 * begin transaction, resolve idempotency, check revision, enforce Product/Workspace
 * ownership, write the record, write exactly one Event, commit — SPEC-001
 * "Implementation details") and throws the typed errors from `./errors.js` for
 * every documented failure. Read methods return the pinned public entity shapes
 * directly — there is no separate internal read representation ("read model" here
 * means these query methods, not a second schema).
 *
 * `initiativeResume` is itself one frozen operation (FR-13): a concrete
 * implementation assembles `InitiativeResumeResponse` server-side in one call: no
 * caller-visible read method decomposition is part of this contract.
 */
import type {
  ArtifactRef,
  Initiative,
  InitiativeRelation,
  InitiativeResumeRequest,
  InitiativeResumeResponse,
  InitiativeWorkspaceLink,
  MutationControl,
  Product,
  Resource,
  Task,
  Workspace,
} from './types.js';
import type {
  ArtifactGetInput,
  ArtifactRegisterInput,
  InitiativeCreateInput,
  InitiativeLinkWorkspaceInput,
  InitiativeListInput,
  InitiativeLookupInput,
  InitiativeRelateInput,
  InitiativeRelationsInput,
  InitiativeStatusInput,
  InitiativeTaskCreateInput,
  InitiativeTaskGetInput,
  InitiativeTaskListInput,
  ProductCreateInput,
  ProductLookupInput,
  ResourceListInput,
  ResourceRegisterInput,
  WorkspaceCreateInput,
  WorkspaceGetInput,
  WorkspaceListInput,
} from './schemas.js';

export interface InitiativeRepository {
  /** Closes the store's own `DatabaseSync` connection. Idempotent. */
  close(): void;

  productCreate(input: ProductCreateInput, control: MutationControl): Promise<Product>;
  productGet(input: ProductLookupInput): Promise<Product>;
  productList(): Promise<Product[]>;

  workspaceCreate(input: WorkspaceCreateInput, control: MutationControl): Promise<Workspace>;
  workspaceGet(input: WorkspaceGetInput): Promise<Workspace>;
  workspaceList(input: WorkspaceListInput): Promise<Workspace[]>;

  resourceRegister(input: ResourceRegisterInput, control: MutationControl): Promise<Resource>;
  resourceList(input: ResourceListInput): Promise<Resource[]>;

  initiativeCreate(input: InitiativeCreateInput, control: MutationControl): Promise<Initiative>;
  initiativeGet(input: InitiativeLookupInput): Promise<Initiative>;
  initiativeList(input: InitiativeListInput): Promise<Initiative[]>;
  initiativeStatus(input: InitiativeStatusInput, control: MutationControl): Promise<Initiative>;
  initiativeResume(input: InitiativeResumeRequest): Promise<InitiativeResumeResponse>;
  initiativeLinkWorkspace(input: InitiativeLinkWorkspaceInput, control: MutationControl): Promise<InitiativeWorkspaceLink>;
  initiativeRelate(input: InitiativeRelateInput, control: MutationControl): Promise<InitiativeRelation>;
  initiativeRelations(input: InitiativeRelationsInput): Promise<InitiativeRelation[]>;

  initiativeTaskCreate(input: InitiativeTaskCreateInput, control: MutationControl): Promise<Task>;
  initiativeTaskGet(input: InitiativeTaskGetInput): Promise<Task>;
  initiativeTaskList(input: InitiativeTaskListInput): Promise<Task[]>;

  /** Create-or-update on the composite key `(initiative_id, path_or_uri)` — see SPEC-001. */
  artifactRegister(input: ArtifactRegisterInput, control: MutationControl): Promise<ArtifactRef>;
  artifactGet(input: ArtifactGetInput): Promise<ArtifactRef>;
}
