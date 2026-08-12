/**
 * Initiative Record — the SQLite-backed store (Phase A0 kernel).
 *
 * Task I-2 scope: own the single dedicated `DatabaseSync` connection over
 * `<stateDir>/initiatives.db` (WAL mode, non-zero busy timeout — the same
 * verified pattern as `packages/server/src/application/execution-store.ts`),
 * apply the versioned schema through {@link runInitiativeMigrations} on open,
 * and expose the lifecycle + inspection surface
 * `tests/initiative-record/migration-and-store.test.ts` checks against.
 *
 * Task I-3 scope: `execute()`, the single synchronous entry point for every
 * mutating operation (SPEC-001 "Implementation details" write algorithm):
 * validate with Zod; begin one explicit transaction; resolve an idempotency
 * replay by `(operation, idempotency_key)` and the canonical request hash;
 * compare `expected_revision` (0 for a create-like operation, the stored
 * current revision for `initiative_status` and an existing-key
 * `artifact_register`); write the record; allocate the next installation-wide
 * `event_sequence` and write exactly one append-only Event carrying the full
 * request provenance and the frozen payload for that mutation (Data model
 * event-type table); persist the idempotency result when a key was supplied;
 * commit. Any thrown error rolls back the whole transaction, so no partial
 * record, Event, or idempotency write survives a failure. Read methods (Task
 * I-4) are added on top of this same connection in a later task; this class
 * is deliberately the one place that owns `db` so that task extends it rather
 * than opening a second connection to the same file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CrossProductWorkspaceLinkError,
  fieldErrorsFromIssues,
  InvalidRequestError,
  NotFoundError,
  RevisionConflictError,
} from './errors.js';
import { runInitiativeMigrations } from './migrations.js';
import {
  initiativeMutationRequestSchema,
  type ArtifactRegisterInput,
  type InitiativeCreateInput,
  type InitiativeLinkWorkspaceInput,
  type InitiativeMutationRequest,
  type InitiativeRelateInput,
  type InitiativeStatusInput,
  type InitiativeTaskCreateInput,
  type ProductCreateInput,
  type ProvenanceInput,
  type ResourceRegisterInput,
  type WorkspaceCreateInput,
} from './schemas.js';
import type {
  ArtifactRef,
  Event,
  Initiative,
  InitiativeRecordEntity,
  InitiativeRelation,
  InitiativeWorkspaceLink,
  Product,
  Resource,
  Task,
  Workspace,
} from './types.js';

export interface InitiativeRecordStorePragmas {
  journal_mode: string;
  busy_timeout: number;
}

/** Raw `initiatives` table row shape (snake_case columns — internal only). */
interface InitiativeRow {
  uuid: string;
  human_key: string;
  product_id: string;
  title: string;
  goal: string;
  status: Initiative['status'];
  outcome: Initiative['outcome'];
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `artifact_refs` table row shape (snake_case columns — internal only). */
interface ArtifactRefRow {
  uuid: string;
  initiative_id: string;
  storage_mode: ArtifactRef['storage_mode'];
  path_or_uri: string;
  content_hash: string | null;
  media_type: string | null;
  version: string | null;
  produced_by_task: string | null;
  description: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `events` table row shape (snake_case columns — internal only). */
interface EventRow {
  event_sequence: number;
  entity_type: Event['entity_type'];
  entity_id: string;
  initiative_id: string | null;
  event_type: string;
  payload: string;
  actor_type: Event['actor_type'];
  actor_id: string;
  interface: string;
  initiated_by: string;
  authorized_by: string;
  timestamp: string;
  source: string;
}

/** Deterministically orders object keys so the same logical value hashes the same way regardless of construction order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(source[key]);
        return acc;
      }, {});
  }
  return value;
}

/** The idempotency identity's canonical request hash (FR-8): operation + business input + mutation control, excluding provenance. */
function computeRequestHash(operation: string, input: unknown, expectedRevision: number): string {
  const canonical = JSON.stringify(canonicalize({ operation, input, expected_revision: expectedRevision }));
  return createHash('sha256').update(canonical).digest('hex');
}

export class InitiativeRecordStore {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens (creating or migrating) the dedicated Initiative database at
   * `dbPath`. Never opens, modifies, or attaches `executions.db` — the caller
   * supplies `join(expandHome(config.server.stateDir), 'initiatives.db')`.
   */
  static open(opts: { dbPath: string }): InitiativeRecordStore {
    runInitiativeMigrations({ dbPath: opts.dbPath });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      return new InitiativeRecordStore(db);
    } catch (error) {
      // Guard against a leaked native handle if a PRAGMA throws after `new
      // DatabaseSync` already assigned a live handle — nothing else holds a
      // reference to close it otherwise.
      if (db) {
        try {
          db.close();
        } catch {
          // already closed / never fully opened — nothing more to release.
        }
      }
      throw error;
    }
  }

  /** Test/inspection use: this store connection's own pragma settings. */
  inspectPragmas(): InitiativeRecordStorePragmas {
    const journalRow = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    const busyRow = this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    return {
      journal_mode: String(journalRow?.journal_mode ?? ''),
      busy_timeout: Number(busyRow?.timeout ?? 0),
    };
  }

  /** Test/inspection use: table and view names currently present in the schema. */
  listSchemaTables(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
      .all() as Array<{ name?: string }>;
    return rows.map((row) => String(row.name));
  }

  /**
   * Validates `rawRequest` against {@link initiativeMutationRequestSchema} and,
   * on success, transactionally applies exactly one mutating operation (Task
   * I-3 write algorithm — see class doc). Synchronous: everything happens on
   * this store's single `DatabaseSync` connection inside one explicit SQLite
   * transaction. Throws a typed error from `./errors.js`; never partially
   * writes a record, Event, or idempotency result.
   */
  execute(rawRequest: unknown): InitiativeRecordEntity {
    const parsed = initiativeMutationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InvalidRequestError({ field_errors: fieldErrorsFromIssues(parsed.error.issues) });
    }
    const request = parsed.data;
    const requestHash = computeRequestHash(request.operation, request.input, request.expected_revision);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (request.idempotency_key) {
        const existing = this.db
          .prepare(`SELECT request_hash, result_json FROM idempotency_results WHERE operation = ? AND idempotency_key = ?`)
          .get(request.operation, request.idempotency_key) as { request_hash?: string; result_json?: string } | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new InvalidRequestError({
              field_errors: {
                idempotency_key: ['reused with a different business input or mutation control'],
              },
              message: `invalid_request: idempotency key ${request.idempotency_key} for operation ${request.operation} was reused with a different request`,
            });
          }
          this.db.exec('COMMIT');
          return JSON.parse(existing.result_json ?? 'null') as InitiativeRecordEntity;
        }
      }

      const result = this.applyMutation(request);

      if (request.idempotency_key) {
        this.db
          .prepare(
            `INSERT INTO idempotency_results (operation, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(request.operation, request.idempotency_key, requestHash, JSON.stringify(result), request.provenance.timestamp);
      }

      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be aborted by the failure above — nothing more to undo.
      }
      throw error;
    }
  }

  /** Test/inspection use: stored Events, optionally scoped to one Initiative, ordered by `event_sequence` ascending. */
  listEvents(filter: { initiative_id?: string } = {}): Event[] {
    const rows = (
      filter.initiative_id
        ? this.db
            .prepare(`SELECT * FROM events WHERE initiative_id = ? ORDER BY event_sequence ASC`)
            .all(filter.initiative_id)
        : this.db.prepare(`SELECT * FROM events ORDER BY event_sequence ASC`).all()
    ) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  /** Dispatches one validated mutating request to its write handler. Runs inside the caller's open transaction. */
  private applyMutation(request: InitiativeMutationRequest): InitiativeRecordEntity {
    switch (request.operation) {
      case 'product_create':
        return this.mutateProductCreate(request.input, request.expected_revision, request.provenance);
      case 'workspace_create':
        return this.mutateWorkspaceCreate(request.input, request.expected_revision, request.provenance);
      case 'resource_register':
        return this.mutateResourceRegister(request.input, request.expected_revision, request.provenance);
      case 'initiative_create':
        return this.mutateInitiativeCreate(request.input, request.expected_revision, request.provenance);
      case 'initiative_status':
        return this.mutateInitiativeStatus(request.input, request.expected_revision, request.provenance);
      case 'initiative_link_workspace':
        return this.mutateInitiativeLinkWorkspace(request.input, request.expected_revision, request.provenance);
      case 'initiative_relate':
        return this.mutateInitiativeRelate(request.input, request.expected_revision, request.provenance);
      case 'initiative_task_create':
        return this.mutateInitiativeTaskCreate(request.input, request.expected_revision, request.provenance);
      case 'artifact_register':
        return this.mutateArtifactRegister(request.input, request.expected_revision, request.provenance);
      default: {
        const exhaustive: never = request;
        throw new InvalidRequestError({
          field_errors: { operation: ['unsupported mutation operation'] },
          message: `invalid_request: unsupported mutation operation ${JSON.stringify(exhaustive)}`,
        });
      }
    }
  }

  /** A create-like operation's `expected_revision` must be exactly 0 — the entity does not yet exist. */
  private requireCreateRevision(expectedRevision: number, entityType: string): void {
    if (expectedRevision !== 0) {
      throw new RevisionConflictError({
        entity_type: entityType,
        entity_id: '',
        expected_revision: expectedRevision,
        actual_revision: 0,
      });
    }
  }

  private nextEventSequence(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next FROM events`).get() as
      | { next?: number }
      | undefined;
    return Number(row?.next ?? 1);
  }

  /** Writes exactly one append-only Event row using the request's provenance. Runs inside the caller's open transaction. */
  private writeEvent(params: {
    entity_type: Event['entity_type'];
    entity_id: string;
    initiative_id: string | null;
    event_type: string;
    payload: Record<string, unknown>;
    provenance: ProvenanceInput;
  }): void {
    const sequence = this.nextEventSequence();
    this.db
      .prepare(
        `INSERT INTO events (event_sequence, entity_type, entity_id, initiative_id, event_type, payload, actor_type, actor_id, interface, initiated_by, authorized_by, timestamp, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequence,
        params.entity_type,
        params.entity_id,
        params.initiative_id,
        params.event_type,
        JSON.stringify(params.payload),
        params.provenance.actor_type,
        params.provenance.actor_id,
        params.provenance.interface,
        params.provenance.initiated_by,
        params.provenance.authorized_by,
        params.provenance.timestamp,
        params.provenance.source,
      );
  }

  private findInitiativeRow(uuid?: string, humanKey?: string): InitiativeRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM initiatives WHERE uuid = ?`).get(uuid) as InitiativeRow | undefined;
    }
    if (humanKey) {
      return this.db.prepare(`SELECT * FROM initiatives WHERE human_key = ?`).get(humanKey) as InitiativeRow | undefined;
    }
    return undefined;
  }

  /** Allocates the next installation-monotonic `MMA-INIT-<n>` human key (FR-6), zero-padded to at least 3 digits. */
  private allocateInitiativeHumanKey(): string {
    const row = this.db.prepare(`SELECT value FROM counters WHERE name = 'initiative_human_key'`).get() as
      | { value?: number }
      | undefined;
    const next = (row?.value ?? 0) + 1;
    this.db.prepare(`UPDATE counters SET value = ? WHERE name = 'initiative_human_key'`).run(next);
    return `MMA-INIT-${String(next).padStart(3, '0')}`;
  }

  private mutateProductCreate(input: ProductCreateInput, expectedRevision: number, provenance: ProvenanceInput): Product {
    this.requireCreateRevision(expectedRevision, 'Product');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    this.db
      .prepare(`INSERT INTO products (uuid, name, slug, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 0)`)
      .run(uuid, input.name, input.slug, now, now);
    const product: Product = { uuid, name: input.name, slug: input.slug, createdAt: now, updatedAt: now, revision: 0 };
    this.writeEvent({
      entity_type: 'Product',
      entity_id: uuid,
      initiative_id: null,
      event_type: 'product_created',
      payload: { uuid, slug: input.slug },
      provenance,
    });
    return product;
  }

  private mutateWorkspaceCreate(
    input: WorkspaceCreateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Workspace {
    this.requireCreateRevision(expectedRevision, 'Workspace');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    this.db
      .prepare(
        `INSERT INTO workspaces (uuid, product_id, name, slug, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, input.product_id, input.name, input.slug, input.description, now, now);
    const workspace: Workspace = {
      uuid,
      product_id: input.product_id,
      name: input.name,
      slug: input.slug,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Workspace',
      entity_id: uuid,
      initiative_id: null,
      event_type: 'workspace_created',
      payload: { uuid, product_id: input.product_id, slug: input.slug },
      provenance,
    });
    return workspace;
  }

  private mutateResourceRegister(
    input: ResourceRegisterInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Resource {
    this.requireCreateRevision(expectedRevision, 'Resource');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const localPath = input.local_path ?? null;
    this.db
      .prepare(
        `INSERT INTO resources (uuid, workspace_id, type, canonical_locator, local_path, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, input.workspace_id, input.type, input.canonical_locator, localPath, input.description, now, now);
    const resource: Resource = {
      uuid,
      workspace_id: input.workspace_id,
      type: input.type,
      canonical_locator: input.canonical_locator,
      local_path: localPath,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Resource',
      entity_id: uuid,
      initiative_id: null,
      event_type: 'resource_registered',
      payload: { uuid, workspace_id: input.workspace_id, canonical_locator: input.canonical_locator },
      provenance,
    });
    return resource;
  }

  private mutateInitiativeCreate(
    input: InitiativeCreateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Initiative {
    this.requireCreateRevision(expectedRevision, 'Initiative');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateInitiativeHumanKey();
    this.db
      .prepare(
        `INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, humanKey, input.product_id, input.title, input.goal, input.status, input.outcome, now, now);
    const initiative: Initiative = {
      uuid,
      human_key: humanKey,
      product_id: input.product_id,
      title: input.title,
      goal: input.goal,
      status: input.status,
      outcome: input.outcome,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: uuid,
      initiative_id: uuid,
      event_type: 'initiative_created',
      payload: { uuid, human_key: humanKey, product_id: input.product_id },
      provenance,
    });
    return initiative;
  }

  private mutateInitiativeStatus(
    input: InitiativeStatusInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Initiative {
    const row = this.findInitiativeRow(input.uuid, input.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.uuid ?? input.human_key ?? '' });
    }
    if (row.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Initiative',
        entity_id: row.uuid,
        expected_revision: expectedRevision,
        actual_revision: row.revision,
      });
    }
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE initiatives SET status = ?, outcome = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.status, input.outcome, now, nextRevision, row.uuid);
    const initiative: Initiative = {
      uuid: row.uuid,
      human_key: row.human_key,
      product_id: row.product_id,
      title: row.title,
      goal: row.goal,
      status: input.status,
      outcome: input.outcome,
      createdAt: row.created_at,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'initiative_status_changed',
      payload: { uuid: row.uuid, human_key: row.human_key, status: input.status, outcome: input.outcome },
      provenance,
    });
    return initiative;
  }

  private mutateInitiativeLinkWorkspace(
    input: InitiativeLinkWorkspaceInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): InitiativeWorkspaceLink {
    this.requireCreateRevision(expectedRevision, 'InitiativeWorkspaceLink');
    const initiative = this.findInitiativeRow(input.initiative_id, undefined);
    if (!initiative) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.initiative_id });
    }
    const workspace = this.db.prepare(`SELECT uuid, product_id FROM workspaces WHERE uuid = ?`).get(input.workspace_id) as
      | { uuid?: string; product_id?: string }
      | undefined;
    if (!workspace) {
      throw new NotFoundError({ entity_type: 'Workspace', lookup: input.workspace_id });
    }
    if (workspace.product_id !== initiative.product_id) {
      throw new CrossProductWorkspaceLinkError({ initiative_id: input.initiative_id, workspace_id: input.workspace_id });
    }
    const now = provenance.timestamp;
    this.db
      .prepare(
        `INSERT INTO initiative_workspace_links (initiative_id, workspace_id, role, created_at, revision) VALUES (?, ?, ?, ?, 0)`,
      )
      .run(input.initiative_id, input.workspace_id, input.role, now);
    const link: InitiativeWorkspaceLink = {
      initiative_id: input.initiative_id,
      workspace_id: input.workspace_id,
      role: input.role,
      createdAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'InitiativeWorkspaceLink',
      entity_id: `${input.initiative_id}:${input.workspace_id}:${input.role}`,
      initiative_id: input.initiative_id,
      event_type: 'initiative_workspace_linked',
      payload: { initiative_id: input.initiative_id, workspace_id: input.workspace_id, role: input.role },
      provenance,
    });
    return link;
  }

  private mutateInitiativeRelate(
    input: InitiativeRelateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): InitiativeRelation {
    this.requireCreateRevision(expectedRevision, 'InitiativeRelation');
    if (!this.findInitiativeRow(input.from_id, undefined)) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.from_id });
    }
    if (!this.findInitiativeRow(input.to_id, undefined)) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.to_id });
    }
    const now = provenance.timestamp;
    this.db
      .prepare(`INSERT INTO initiative_relations (from_id, to_id, type, created_at, revision) VALUES (?, ?, ?, ?, 0)`)
      .run(input.from_id, input.to_id, input.type, now);
    const relation: InitiativeRelation = {
      from_id: input.from_id,
      to_id: input.to_id,
      type: input.type,
      createdAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'InitiativeRelation',
      entity_id: `${input.from_id}:${input.to_id}:${input.type}`,
      initiative_id: input.from_id,
      event_type: 'initiative_related',
      payload: { from_id: input.from_id, to_id: input.to_id, type: input.type },
      provenance,
    });
    return relation;
  }

  private mutateInitiativeTaskCreate(
    input: InitiativeTaskCreateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Task {
    this.requireCreateRevision(expectedRevision, 'Task');
    if (!this.findInitiativeRow(input.initiative_id, undefined)) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.initiative_id });
    }
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const executionRefs = input.executionRefs ?? [];
    this.db
      .prepare(
        `INSERT INTO tasks (uuid, initiative_id, title, goal, status, outcome, workspace_ids, resource_ids, execution_refs, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        uuid,
        input.initiative_id,
        input.title,
        input.goal,
        input.status,
        input.outcome,
        JSON.stringify(input.workspace_ids),
        JSON.stringify(input.resource_ids),
        JSON.stringify(executionRefs),
        now,
        now,
      );
    const task: Task = {
      uuid,
      initiative_id: input.initiative_id,
      title: input.title,
      goal: input.goal,
      status: input.status,
      outcome: input.outcome,
      workspace_ids: input.workspace_ids,
      resource_ids: input.resource_ids,
      executionRefs,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: uuid,
      initiative_id: input.initiative_id,
      event_type: 'task_created',
      payload: { uuid, initiative_id: input.initiative_id, status: input.status },
      provenance,
    });
    return task;
  }

  private mutateArtifactRegister(
    input: ArtifactRegisterInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): ArtifactRef {
    const existingRow = this.db
      .prepare(`SELECT * FROM artifact_refs WHERE initiative_id = ? AND path_or_uri = ?`)
      .get(input.initiative_id, input.path_or_uri) as ArtifactRefRow | undefined;
    const now = provenance.timestamp;
    const contentHash = input.content_hash ?? null;
    const mediaType = input.media_type ?? null;
    const version = input.version ?? null;
    const producedByTask = input.produced_by_task ?? null;

    if (!existingRow) {
      this.requireCreateRevision(expectedRevision, 'ArtifactRef');
      if (!this.findInitiativeRow(input.initiative_id, undefined)) {
        throw new NotFoundError({ entity_type: 'Initiative', lookup: input.initiative_id });
      }
      const uuid = randomUUID();
      this.db
        .prepare(
          `INSERT INTO artifact_refs (uuid, initiative_id, storage_mode, path_or_uri, content_hash, media_type, version, produced_by_task, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          uuid,
          input.initiative_id,
          input.storage_mode,
          input.path_or_uri,
          contentHash,
          mediaType,
          version,
          producedByTask,
          input.description,
          now,
          now,
        );
      const artifact: ArtifactRef = {
        uuid,
        initiative_id: input.initiative_id,
        storage_mode: input.storage_mode,
        path_or_uri: input.path_or_uri,
        content_hash: contentHash,
        media_type: mediaType,
        version,
        produced_by_task: producedByTask,
        description: input.description,
        createdAt: now,
        updatedAt: now,
        revision: 0,
      };
      this.writeEvent({
        entity_type: 'ArtifactRef',
        entity_id: uuid,
        initiative_id: input.initiative_id,
        event_type: 'artifact_registered',
        payload: { uuid, initiative_id: input.initiative_id, path_or_uri: input.path_or_uri, storage_mode: input.storage_mode },
        provenance,
      });
      return artifact;
    }

    if (existingRow.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'ArtifactRef',
        entity_id: existingRow.uuid,
        expected_revision: expectedRevision,
        actual_revision: existingRow.revision,
      });
    }
    const nextRevision = existingRow.revision + 1;
    this.db
      .prepare(
        `UPDATE artifact_refs SET storage_mode = ?, content_hash = ?, media_type = ?, version = ?, produced_by_task = ?, description = ?, updated_at = ?, revision = ? WHERE uuid = ?`,
      )
      .run(input.storage_mode, contentHash, mediaType, version, producedByTask, input.description, now, nextRevision, existingRow.uuid);
    const artifact: ArtifactRef = {
      uuid: existingRow.uuid,
      initiative_id: existingRow.initiative_id,
      storage_mode: input.storage_mode,
      path_or_uri: existingRow.path_or_uri,
      content_hash: contentHash,
      media_type: mediaType,
      version,
      produced_by_task: producedByTask,
      description: input.description,
      createdAt: existingRow.created_at,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'ArtifactRef',
      entity_id: existingRow.uuid,
      initiative_id: existingRow.initiative_id,
      event_type: 'artifact_updated',
      payload: { uuid: existingRow.uuid, initiative_id: existingRow.initiative_id, path_or_uri: existingRow.path_or_uri, content_hash: contentHash },
      provenance,
    });
    return artifact;
  }

  /** Closes the store's own `DatabaseSync` connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Maps one raw `events` row to the public `Event` shape, parsing the JSON payload column. */
function mapEventRow(row: EventRow): Event {
  return {
    event_sequence: Number(row.event_sequence),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    initiative_id: row.initiative_id,
    event_type: row.event_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    interface: row.interface,
    initiated_by: row.initiated_by,
    authorized_by: row.authorized_by,
    timestamp: row.timestamp,
    source: row.source,
  };
}
