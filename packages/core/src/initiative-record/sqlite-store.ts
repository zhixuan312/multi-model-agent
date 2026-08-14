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
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  CrossInitiativeEvidenceLinkError,
  CrossInitiativeVerificationError,
  CrossProductWorkspaceLinkError,
  fieldErrorsFromIssues,
  InitiativeAlreadyExistsError,
  InvalidPhaseTransitionError,
  InvalidRequestError,
  InvalidTaskTransitionError,
  NotFoundError,
  RevisionConflictError,
  TargetAdapterValidationFailedError,
  TaskClaimConflictError,
  TaskNotClaimableError,
  UnknownDeliveryContractError,
  UnknownLifecycleContractError,
  UnknownMethodError,
  VerificationMethodNotRunnableError,
} from './errors.js';
import { evaluateLifecycleGate } from './lifecycle-gates.js';
import { loadDeliveryPackager } from './delivery-packagers.js';
import { runInitiativeMigrations } from './migrations.js';
import { resolveTargetAdapter } from './target-adapters.js';
import {
  deliveryContractDeclarationSchema,
  initiativeMutationRequestSchema,
  methodDeclarationSchema,
  type AcceptanceCriterionAddInput,
  type ArtifactRegisterInput,
  type DecisionRecordInput,
  type DecisionSupersedeInput,
  type DeliverableApproveInput,
  type DeliverableAttachArtifactInput,
  type DeliverableDefineInput,
  type DeliverableDeliverInput,
  type DeliverablePackageInput,
  type DeliverableValidateInput,
  type EvidenceAddInput,
  type EvidenceLinkInput,
  type InitiativeBootstrapInput,
  type InitiativeCreateInput,
  type InitiativeExportSnapshotInput,
  type InitiativeFocusSetInput,
  type InitiativeImportInput,
  type InitiativeLinkWorkspaceInput,
  type InitiativeMutationRequest,
  type InitiativePhaseEnterInput,
  type InitiativePhaseReopenInput,
  type InitiativePhaseSatisfyInput,
  type InitiativePhaseSkipInput,
  type InitiativeRelateInput,
  type InitiativeSetLifecycleContractInput,
  type InitiativeStatusInput,
  type InitiativeTaskClaimInput,
  type InitiativeTaskCompleteInput,
  type InitiativeTaskCreateInput,
  type InitiativeTaskExecutionInput,
  type InitiativeTaskReleaseInput,
  type InitiativeTaskSetMethodInput,
  type ProductCreateInput,
  type ProvenanceInput,
  type RequirementAddInput,
  type ResourceRegisterInput,
  type RiskAddInput,
  type RiskStatusInput,
  type VerificationRecordInput,
  type VerificationRunInput,
  type WorkspaceCreateInput,
} from './schemas.js';
import {
  DEFAULT_LIFECYCLE_CONTRACT_ID,
  DELIVERABLE_VALIDATION_STATES,
  INITIATIVE_EXPORT_SCHEMA_VERSION,
  LIFECYCLE_PHASES,
  VERIFICATION_NON_TERMINAL_STATES,
  VERIFICATION_STALE_ELIGIBLE_STATES,
  VERIFICATION_STATES,
  type AcceptanceCriterion,
  type ArtifactRef,
  type Decision,
  type Deliverable,
  type DeliverableArtifactMember,
  type DeliverablePackageCoverage,
  type DeliverablePackageResult,
  type DeliverableValidationState,
  type DeliveryContract,
  type DeliveryHistoryEntry,
  type Event,
  type Evidence,
  type EvidenceLink,
  type EvidenceLinkTargetType,
  type GateStatus,
  type Initiative,
  type InitiativeBootstrapRequirementResult,
  type InitiativeBootstrapResourceResult,
  type InitiativeBootstrapResult,
  type InitiativeBootstrapWorkspaceResult,
  type InitiativeRecordEntity,
  type InitiativeRelation,
  type InitiativeStatus,
  type InitiativeWorkspaceLink,
  type LifecycleContract,
  type LifecycleResumeBlock,
  type MethodDeclaration,
  type Phase,
  type PhaseRecord,
  type PhaseRecordState,
  type Product,
  type Requirement,
  type Resource,
  type Risk,
  type Task,
  type TaskStatus,
  type VerificationRun,
  type VerificationState,
  type Workspace,
} from './types.js';
import type {
  InitiativeRepository,
  InitiativeWorkspaceLinkRead,
  LatestVerificationRead,
  RelatedInitiativeRead,
  RequirementWithCriteriaRead,
} from './repository.js';

export interface InitiativeRecordStorePragmas {
  journal_mode: string;
  busy_timeout: number;
}

/** The seven `initiative_bootstrap` write-sequence creation steps (SPEC-006 Task I-3), in write order. */
type BootstrapFailureStep =
  | 'product'
  | 'workspace'
  | 'resource'
  | 'initiative'
  | 'initiative_workspace_link'
  | 'requirement'
  | 'acceptance_criterion';

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
  /** NEW in schema version 4 (SPEC-004 Lifecycle Engine) — `null` for a legacy or unfocused Initiative. */
  focus_phase: Phase | null;
  /** NEW in schema version 4 (SPEC-004 Lifecycle Engine) — `null` for a legacy Initiative or a caller-cleared reference. */
  lifecycle_contract: string | null;
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

/** Raw `deliverables` table row shape (snake_case columns — internal only). SPEC-007 Delivery Layer, Task I-3. */
interface DeliverableRow {
  uuid: string;
  initiative_id: string;
  target_type: string;
  delivery_contract: string;
  validation_state: Deliverable['validation_state'];
  validation_detail: string;
  delivery_reference: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `deliverable_artifacts` table row shape (snake_case columns — internal only). SPEC-007 Delivery Layer, Task I-3. */
interface DeliverableArtifactRow {
  deliverable_id: string;
  artifact_id: string;
  requirement: string;
  created_at: string;
}

/** Raw `deliverable_delivery_history` table row shape (snake_case columns — internal only). SPEC-007 Delivery Layer, Task I-4. */
interface DeliveryHistoryRow {
  uuid: string;
  deliverable_id: string;
  delivery_reference: string;
  validation_state: Deliverable['validation_state'];
  created_at: string;
}

/** Raw `products` table row shape (snake_case columns — internal only). */
interface ProductRow {
  uuid: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `workspaces` table row shape (snake_case columns — internal only). */
interface WorkspaceRow {
  uuid: string;
  product_id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `resources` table row shape (snake_case columns — internal only). */
interface ResourceRow {
  uuid: string;
  workspace_id: string;
  type: string;
  canonical_locator: string;
  local_path: string | null;
  description: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `tasks` table row shape (snake_case columns — internal only). */
interface TaskRow {
  uuid: string;
  initiative_id: string;
  title: string;
  goal: string;
  status: Task['status'];
  outcome: Task['outcome'];
  /** NEW in schema version 3 (SPEC-003 Phase B) — `null` for a legacy or unclaimed Task. */
  claimed_by: string | null;
  workspace_ids: string;
  resource_ids: string;
  execution_refs: string;
  created_at: string;
  updated_at: string;
  revision: number;
  /** NEW in schema version 5 (SPEC-005 Method Registry) — `null` for a legacy Task or one that never had a Method set. */
  method: string | null;
}

/** Raw `initiative_workspace_links` table row shape (snake_case columns — internal only). */
interface LinkRow {
  initiative_id: string;
  workspace_id: string;
  role: InitiativeWorkspaceLink['role'];
  created_at: string;
  revision: number;
}

/** Raw `initiative_relations` table row shape (snake_case columns — internal only). */
interface RelationRow {
  from_id: string;
  to_id: string;
  type: InitiativeRelation['type'];
  created_at: string;
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

// ---------------------------------------------------------------------------
// Phase A1 raw row shapes (schema version 2, Task I-2). These mirror the
// `requirements`, `acceptance_criteria`, `decisions`, `evidence`,
// `evidence_links`, `risks`, and `verification_runs` tables added by
// migration version 2 (`./migrations.js`). The public repository layer
// (Task I-3/I-4/I-5) maps each row to the frozen public shape in `./types.js`;
// these interfaces exist so that mapping is typed end to end, not `any`.
// ---------------------------------------------------------------------------

/** Raw `requirements` table row shape (snake_case columns — internal only). */
interface RequirementRow {
  uuid: string;
  initiative_id: string;
  human_key: string;
  statement: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `acceptance_criteria` table row shape (snake_case columns — internal only). */
interface AcceptanceCriterionRow {
  uuid: string;
  requirement_id: string;
  human_key: string;
  statement: string;
  check_reference: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/**
 * Raw `decisions` table row shape (snake_case columns — internal only).
 * `alternatives` is stored as a JSON-encoded array that maps losslessly to
 * `string[]` — the underlying column format is an implementation detail, not
 * part of the public contract.
 */
interface DecisionRow {
  uuid: string;
  initiative_id: string;
  human_key: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string;
  status: Decision['status'];
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** Raw `evidence` table row shape (snake_case columns — internal only). Unique on `(initiative_id, locator)`. */
interface EvidenceRow {
  uuid: string;
  initiative_id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  summary: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/**
 * Raw `evidence_links` table row shape (snake_case columns — internal only).
 * Identified by the composite `(evidence_id, target_type, target_id)`, the
 * sole Phase A1 record with no UUID primary key.
 */
interface EvidenceLinkRow {
  evidence_id: string;
  target_type: EvidenceLink['target_type'];
  target_id: string;
  created_at: string;
  revision: number;
}

/** Raw `risks` table row shape (snake_case columns — internal only). */
interface RiskRow {
  uuid: string;
  initiative_id: string;
  human_key: string;
  statement: string;
  severity: Risk['severity'];
  status: Risk['status'];
  created_at: string;
  updated_at: string;
  revision: number;
}

/**
 * Raw `verification_runs` table row shape (snake_case columns — internal
 * only). Immutable once created, except the system-driven `state`
 * transitions to `'stale'` (FR-11) and `'superseded'` (FR-10).
 */
interface VerificationRunRow {
  uuid: string;
  initiative_id: string;
  acceptance_criterion_id: string;
  method: VerificationRun['method'];
  state: VerificationRun['state'];
  detail: string;
  created_at: string;
  revision: number;
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

/**
 * `verification_run`'s bounded local execution posture: a wall-clock cap so a hung command
 * cannot hold the store's single write transaction open indefinitely, and an output cap so a
 * runaway command cannot grow `verification_runs.detail` unbounded. Neither is caller-
 * configurable — the same "no new knob without a concrete need" posture the rest of this module
 * follows.
 */
/** Initiative-wide inputs shared across a six-phase gate sweep (audit M1-11). */
interface GateInputs {
  requirements: ReturnType<InitiativeRecordStore['listRequirements']>;
  acceptanceCriteria: ReturnType<InitiativeRecordStore['listAcceptanceCriteria']>;
  decisions: ReturnType<InitiativeRecordStore['listDecisions']>;
  events: ReturnType<InitiativeRecordStore['listEvents']>;
  deliverableValidationStates: DeliverableValidationState[];
}

/** Result of running a declared verification command, computed outside the write transaction. */
interface VerificationCommandOutcome { state: VerificationRun['state']; detail: string; }

const VERIFICATION_RUN_TIMEOUT_MS = 120_000;
const VERIFICATION_RUN_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Persisted `detail` text is capped well below any practical SQLite TEXT concern — this bounds
 *  what a single verification run can add to `initiatives.db`'s size, not SQLite's own limit. */
const VERIFICATION_RUN_DETAIL_MAX_CHARS = 20_000;

/**
 * Splits a declared verification command into argv WITHOUT a shell. Supports single and double
 * quoting so a path containing spaces still works; everything else is a literal argument, so a
 * metacharacter is passed to the program rather than interpreted.
 */
function parseVerificationCommand(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else { current += ch; has = true; }
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has) { argv.push(current); current = ''; has = false; } }
    else { current += ch; has = true; }
  }
  if (has) argv.push(current);
  return argv;
}

/** Combines a `spawnSync` result's stdout/stderr into one block, labeling stderr when present. */
function combineCommandOutput(stdout: string | Buffer | null, stderr: string | Buffer | null): string {
  const out = stdout ? stdout.toString() : '';
  const err = stderr ? stderr.toString() : '';
  return err ? `${out}\n--- stderr ---\n${err}`.trim() : out.trim();
}

/** Truncates a `verification_run` detail string to `VERIFICATION_RUN_DETAIL_MAX_CHARS`, noting the cut. */
function truncateVerificationDetail(detail: string): string {
  if (detail.length <= VERIFICATION_RUN_DETAIL_MAX_CHARS) return detail;
  return `${detail.slice(0, VERIFICATION_RUN_DETAIL_MAX_CHARS)}\n...[truncated]`;
}

/**
 * The idempotency identity's canonical request hash (FR-8): operation +
 * business input + mutation control + the five CALLER-OWNED provenance fields.
 * The two ADAPTER-STAMPED fields (`interface`, `timestamp`) are excluded —
 * adapters stamp a fresh server timestamp on every call, so including them
 * would make every legitimate retry a hash mismatch. Including the caller
 * fields means a replay under a different claimed identity (actor, authorizer,
 * source) is rejected as `invalid_request` instead of silently returning a
 * result attributed to someone else.
 */
function computeRequestHash(
  operation: string,
  input: unknown,
  expectedRevision: number,
  provenance: { actor_type: string; actor_id: string; initiated_by: string; authorized_by: string; source: string },
): string {
  const canonical = JSON.stringify(
    canonicalize({
      operation,
      input,
      expected_revision: expectedRevision,
      actor_type: provenance.actor_type,
      actor_id: provenance.actor_id,
      initiated_by: provenance.initiated_by,
      authorized_by: provenance.authorized_by,
      source: provenance.source,
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export class InitiativeRecordStore implements InitiativeRepository {
  private closed = false;
  /** Test-only `initiative_bootstrap` failure-injection hook — see `setBootstrapFailureStepForTest`. */
  private bootstrapFailureStepForTest: BootstrapFailureStep | undefined;

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
    const requestHash = computeRequestHash(request.operation, request.input, request.expected_revision, request.provenance);

    // `verification_run` is the ONE operation that waits on something outside SQLite, and it may
    // wait up to VERIFICATION_RUN_TIMEOUT_MS. Running it inside the write transaction below would
    // hold `BEGIN IMMEDIATE` — and therefore block every other read and write on this connection —
    // for the whole duration of somebody's test suite. The command runs here, before the lock is
    // taken; the transaction then only persists its result, which is fast (audit M1-3).
    const preRunVerification = request.operation === 'verification_run'
      ? this.runVerificationCommand(request.input as VerificationRunInput)
      : undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // EvidenceLink's composite identity is an identity-level no-op. It must
      // take precedence over idempotency replay so that a duplicate link is
      // returned unchanged for any key, and so the no-op never creates an
      // idempotency-result row.
      if (request.operation === 'evidence_link') {
        const existingLink = this.db
          .prepare(`SELECT * FROM evidence_links WHERE evidence_id = ? AND target_type = ? AND target_id = ?`)
          .get(request.input.evidence_id, request.input.target_type, request.input.target_id) as EvidenceLinkRow | undefined;
        if (existingLink) {
          this.db.exec('COMMIT');
          return mapEvidenceLinkRow(existingLink);
        }
      }

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

      const result = this.applyMutation(request, preRunVerification);

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

  /**
   * This store connection's own pragma settings. Connection state — `busy_timeout` in particular —
   * is per-connection and invisible to any other reader of the same file, so the only way to
   * assert the store configures its connection correctly is to ask the store. Kept for that
   * reason; the schema-shape sibling was removed because a plain connection can read it (audit
   * M1-10).
   */
  inspectPragmas(): InitiativeRecordStorePragmas {
    const journalRow = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    const busyRow = this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    return {
      journal_mode: String(journalRow?.journal_mode ?? ''),
      busy_timeout: Number(busyRow?.timeout ?? 0),
    };
  }

  /** Stored Events, optionally scoped to one Initiative, ordered by `event_sequence` ascending. */
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

  // ---------------------------------------------------------------------
  // Phase A1 reads needed to verify Task I-3's and Task I-4's own mutations
  // (SPEC-002). `getDecision` is implemented because `decision_supersede`'s
  // check reads the old Decision back to confirm `status: 'superseded'` and
  // `superseded_by`. `getVerificationRun` is implemented because Task I-4's
  // own check verifies the system-driven `'stale'`/`'superseded'`
  // transitions. Every other Phase A1 read (Requirement, Acceptance
  // Criterion, Evidence, Risk, and all `list*`/count/resume joins) is Task
  // I-5 scope, added alongside the read operations below.
  // ---------------------------------------------------------------------

  /** `decision_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getDecision(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Decision {
    const row = this.findDecisionRow(lookup.uuid, lookup.initiative_id, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Decision', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    return mapDecisionRow(row);
  }

  /** `verification_get` — `uuid`. Throws `not_found`. */
  getVerificationRun(lookup: { uuid: string }): VerificationRun {
    const row = this.db.prepare(`SELECT * FROM verification_runs WHERE uuid = ?`).get(lookup.uuid) as
      | VerificationRunRow
      | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'VerificationRun', lookup: lookup.uuid });
    }
    return mapVerificationRunRow(row);
  }

  // ---------------------------------------------------------------------
  // SPEC-005 Method Registry reads (Task I-2, ← AC-1.3). `methods` is seeded
  // once by migration 5 (`INSERT OR IGNORE`, exactly the nine frozen
  // built-in declarations) and never written by any runtime path — these
  // two reads are the store's only access to that table. `method_get` and
  // `method_list` dispatch through `execute()`'s read map is Task I-3's
  // scope; this task only makes the reads themselves true.
  // ---------------------------------------------------------------------

  /** `method_get` — `id`. Throws `unknown_method` for an unregistered identifier. */
  getMethod(lookup: { id: string }): MethodDeclaration {
    return this.getMethodOrThrow(lookup.id);
  }

  /** `method_list` — every registered declaration, in stable ascending identifier order. */
  listMethods(): MethodDeclaration[] {
    const rows = this.db.prepare(`SELECT id, definition_json FROM methods ORDER BY id ASC`).all() as unknown as Array<{
      id: string;
      definition_json: string;
    }>;
    return rows.map((row) => this.parseMethodDeclaration(row.id, row.definition_json));
  }

  /** Loads a registered Method's `definition_json`. Throws `unknown_method` for an unregistered id. */
  private getMethodOrThrow(id: string): MethodDeclaration {
    const row = this.db.prepare(`SELECT definition_json FROM methods WHERE id = ?`).get(id) as
      | { definition_json?: string }
      | undefined;
    if (!row || row.definition_json === undefined) {
      throw new UnknownMethodError({ method: id });
    }
    return this.parseMethodDeclaration(id, row.definition_json);
  }

  /**
   * Parses and strictly re-validates a stored Method's `definition_json` against
   * {@link methodDeclarationSchema} rather than trusting the stored bytes as-is — a store read
   * never returns a partial or malformed declaration. Malformed JSON or a shape that fails the
   * strict schema throws `invalid_request`; both are store-corruption conditions that cannot
   * occur through any caller-visible write path (there is no Method write path), so this only
   * guards against a directly edited or otherwise corrupted `initiatives.db`.
   */
  private parseMethodDeclaration(id: string, definitionJson: string): MethodDeclaration {
    let parsed: unknown;
    try {
      parsed = JSON.parse(definitionJson);
    } catch {
      throw new InvalidRequestError({
        field_errors: { method: [`registered Method '${id}' has malformed stored definition JSON`] },
        message: `invalid_request: Method '${id}' has malformed stored definition JSON`,
      });
    }
    const result = methodDeclarationSchema.safeParse(parsed);
    if (!result.success) {
      throw new InvalidRequestError({ field_errors: fieldErrorsFromIssues(result.error.issues) });
    }
    if (result.data.id !== id) {
      throw new InvalidRequestError({
        field_errors: { method: [`registered Method row '${id}' does not match declaration id '${result.data.id}'`] },
        message: `invalid_request: Method row '${id}' does not match its stored declaration id`,
      });
    }
    return result.data;
  }

  // ---------------------------------------------------------------------
  // SPEC-007 Delivery Layer — Delivery Contract registry reads (Task I-1,
  // ← AC-1.1, AC-1.2, AC-1.3). `delivery_contracts` is seeded once by
  // migration 7 (`INSERT OR IGNORE`, exactly the two frozen built-in
  // declarations) and never written by any runtime path — these two reads
  // are the store's only access to that table. `delivery_contract_get` and
  // `delivery_contract_list` dispatch through `execute()`'s read map is a
  // later task's scope; this task only makes the reads themselves true.
  // ---------------------------------------------------------------------

  /** `delivery_contract_get` — `id`. Throws `unknown_delivery_contract` for an unregistered identifier. */
  getDeliveryContract(lookup: { id: string }): DeliveryContract {
    return this.getDeliveryContractOrThrow(lookup.id);
  }

  /** `delivery_contract_list` — every registered declaration, in stable ascending identifier order. */
  listDeliveryContracts(): DeliveryContract[] {
    const rows = this.db.prepare(`SELECT id, definition_json FROM delivery_contracts ORDER BY id ASC`).all() as unknown as Array<{
      id: string;
      definition_json: string;
    }>;
    return rows.map((row) => this.parseDeliveryContractDeclaration(row.id, row.definition_json));
  }

  /** Loads a registered Delivery Contract's `definition_json`. Throws `unknown_delivery_contract` for an unregistered id. */
  private getDeliveryContractOrThrow(id: string): DeliveryContract {
    const row = this.db.prepare(`SELECT definition_json FROM delivery_contracts WHERE id = ?`).get(id) as
      | { definition_json?: string }
      | undefined;
    if (!row || row.definition_json === undefined) {
      throw new UnknownDeliveryContractError({ delivery_contract: id });
    }
    return this.parseDeliveryContractDeclaration(id, row.definition_json);
  }

  /**
   * Parses and strictly re-validates a stored Delivery Contract's `definition_json` against
   * {@link deliveryContractDeclarationSchema} rather than trusting the stored bytes as-is — a
   * store read never returns a partial or malformed declaration. Malformed JSON or a shape that
   * fails the strict schema throws `invalid_request`; both are store-corruption conditions that
   * cannot occur through any caller-visible write path (there is no Delivery Contract write
   * path), so this only guards against a directly edited or otherwise corrupted `initiatives.db`.
   */
  private parseDeliveryContractDeclaration(id: string, definitionJson: string): DeliveryContract {
    let parsed: unknown;
    try {
      parsed = JSON.parse(definitionJson);
    } catch {
      throw new InvalidRequestError({
        field_errors: { delivery_contract: [`registered Delivery Contract '${id}' has malformed stored definition JSON`] },
        message: `invalid_request: Delivery Contract '${id}' has malformed stored definition JSON`,
      });
    }
    const result = deliveryContractDeclarationSchema.safeParse(parsed);
    if (!result.success) {
      throw new InvalidRequestError({ field_errors: fieldErrorsFromIssues(result.error.issues) });
    }
    if (result.data.id !== id) {
      throw new InvalidRequestError({
        field_errors: {
          delivery_contract: [`registered Delivery Contract row '${id}' does not match declaration id '${result.data.id}'`],
        },
        message: `invalid_request: Delivery Contract row '${id}' does not match its stored declaration id`,
      });
    }
    return result.data;
  }

  // ---------------------------------------------------------------------
  // SPEC-007 Delivery Layer — Deliverable reads (Task I-3, ← AC-1.4, AC-1.5,
  // AC-1.6). `deliverable_validate`/`deliverable_deliver` (Task I-4) and
  // `deliverable_approve` (Task I-6) extend `deliverables` further; these two
  // reads only surface what `mutateDeliverableDefine`/`mutateDeliverableAttachArtifact`
  // (below) write.
  // ---------------------------------------------------------------------

  /** `deliverable_get` — `uuid`. Throws `not_found` for an unknown identifier. */
  getDeliverable(lookup: { uuid: string }): Deliverable {
    return mapDeliverableRow(this.requireDeliverableRow(lookup.uuid));
  }

  /** `deliverable_list` — every Deliverable for one Initiative, ordered `createdAt` ascending, then `uuid` ascending. */
  listDeliverables(filter: { initiative_id: string }): Deliverable[] {
    const rows = this.db
      .prepare(`SELECT * FROM deliverables WHERE initiative_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(filter.initiative_id) as unknown as DeliverableRow[];
    return rows.map(mapDeliverableRow);
  }

  /**
   * Every immutable `deliverable_delivery_history` row for a Deliverable, in true insertion
   * order. Ordered by SQLite's implicit `rowid` (the table declares no `WITHOUT ROWID` clause
   * and no dedicated sequence column — `created_at` alone is NOT a safe sort key here: caller
   * provenance timestamps are not guaranteed unique-per-millisecond, e.g. two deliveries in the
   * same test/request tick share one `created_at`, and `uuid` is random, so `created_at, uuid`
   * would silently reorder history under a timestamp collision). Never updated or deleted —
   * `mutateDeliverableDeliver` (Task I-4, ← AC-1.8) only ever inserts a new row.
   */
  listDeliveryHistory(filter: { deliverable_id: string }): DeliveryHistoryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM deliverable_delivery_history WHERE deliverable_id = ? ORDER BY rowid ASC`)
      .all(filter.deliverable_id) as unknown as DeliveryHistoryRow[];
    return rows.map(mapDeliveryHistoryRow);
  }

  /** Every `DeliverableArtifactMember` row for one Deliverable (MMA Next gap-closure: shared by
   *  `deliverable_package` and `initiative_export`), ordered `created_at` ascending, then
   *  `artifact_id`/`requirement` ascending for a stable, deterministic order. */
  listDeliverableMembers(filter: { deliverable_id: string }): DeliverableArtifactMember[] {
    const rows = this.db
      .prepare(
        `SELECT deliverable_id, artifact_id, requirement, created_at FROM deliverable_artifacts WHERE deliverable_id = ? ORDER BY created_at ASC, artifact_id ASC, requirement ASC`,
      )
      .all(filter.deliverable_id) as unknown as DeliverableArtifactRow[];
    return rows.map(mapDeliverableArtifactRow);
  }

  /** Resume/export count: Deliverable counts by validation_state — every `DeliverableValidationState` key present, defaulting to `0` (mirrors `countVerificationByState`). */
  countDeliverablesByValidationState(initiativeId: string): Record<DeliverableValidationState, number> {
    const counts = Object.fromEntries(DELIVERABLE_VALIDATION_STATES.map((state) => [state, 0])) as Record<
      DeliverableValidationState,
      number
    >;
    const rows = this.db
      .prepare(`SELECT validation_state, COUNT(*) AS count FROM deliverables WHERE initiative_id = ? GROUP BY validation_state`)
      .all(initiativeId) as Array<{ validation_state: DeliverableValidationState; count: number }>;
    for (const row of rows) {
      counts[row.validation_state] = Number(row.count);
    }
    return counts;
  }

  /**
   * Export join (MMA Next gap-closure): the Initiative's Workspace links, each carrying its OWN
   * `InitiativeWorkspaceLink` row (`created_at`/`revision`) — unlike `getInitiativeWorkspaceLinks`
   * (the resume join, which omits link-level metadata) — plus the joined Workspace and Resources.
   */
  listInitiativeWorkspaceLinksWithDetail(filter: {
    initiative_id: string;
  }): Array<{ link: InitiativeWorkspaceLink; workspace: Workspace; resources: Resource[] }> {
    const rows = this.db
      .prepare(`SELECT * FROM initiative_workspace_links WHERE initiative_id = ? ORDER BY created_at ASC, workspace_id ASC, role ASC`)
      .all(filter.initiative_id) as unknown as LinkRow[];
    return rows.map((row) => {
      const workspaceRow = this.db.prepare(`SELECT * FROM workspaces WHERE uuid = ?`).get(row.workspace_id) as
        | WorkspaceRow
        | undefined;
      if (!workspaceRow) {
        throw new NotFoundError({ entity_type: 'Workspace', lookup: row.workspace_id });
      }
      const workspace = mapWorkspaceRow(workspaceRow);
      const link: InitiativeWorkspaceLink = {
        initiative_id: row.initiative_id,
        workspace_id: row.workspace_id,
        role: row.role,
        createdAt: row.created_at,
        revision: Number(row.revision),
      };
      return { link, workspace, resources: this.listResources({ workspace_id: workspace.uuid }) };
    });
  }

  /**
   * Export read (MMA Next gap-closure): every PERSISTED `phase_records` row for one Initiative,
   * in `LIFECYCLE_PHASES` order — no synthesized `not_started` defaults (unlike
   * {@link getPhaseStates}, which this reuses: no code path ever stores a `'not_started'` row, so
   * filtering its overlay to non-default entries is exactly "which rows exist").
   */
  listPhaseRecords(filter: { initiative_id: string }): Array<{ phase: Phase; state: PhaseRecordState }> {
    const states = this.getPhaseStates(filter.initiative_id);
    return LIFECYCLE_PHASES.filter((phase) => states[phase] !== 'not_started').map((phase) => ({ phase, state: states[phase] }));
  }

  /** Returns the raw `deliverables` row for `uuid`, or throws `not_found`. Shared by reads and the attach mutation's revision check. */
  private requireDeliverableRow(uuid: string): DeliverableRow {
    const row = this.db.prepare(`SELECT * FROM deliverables WHERE uuid = ?`).get(uuid) as DeliverableRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'Deliverable', lookup: uuid });
    }
    return row;
  }

  /** Throws `revision_conflict` if `row.revision` does not match `expectedRevision`. */
  private requireDeliverableRevision(row: DeliverableRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Deliverable',
        entity_id: row.uuid,
        expected_revision: expectedRevision,
        actual_revision: row.revision,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Read operations (Task I-4) — one method per frozen get/list operation,
  // plus the joined read methods `initiative_resume` (Task I-5) composes
  // from. Every `get*` throws typed `not_found` for an unknown lookup.
  // ---------------------------------------------------------------------

  /** `product_get` — `uuid` or `slug`. */
  getProduct(lookup: { uuid?: string; slug?: string }): Product {
    const row = lookup.uuid
      ? (this.db.prepare(`SELECT * FROM products WHERE uuid = ?`).get(lookup.uuid) as ProductRow | undefined)
      : lookup.slug
        ? (this.db.prepare(`SELECT * FROM products WHERE slug = ?`).get(lookup.slug) as ProductRow | undefined)
        : undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'Product', lookup: lookup.uuid ?? lookup.slug ?? '' });
    }
    return mapProductRow(row);
  }

  /** `product_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listProducts(): Product[] {
    const rows = this.db.prepare(`SELECT * FROM products ORDER BY created_at ASC, uuid ASC`).all() as unknown as ProductRow[];
    return rows.map(mapProductRow);
  }

  /** `workspace_get` — `uuid`. */
  getWorkspace(lookup: { uuid: string }): Workspace {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE uuid = ?`).get(lookup.uuid) as WorkspaceRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'Workspace', lookup: lookup.uuid });
    }
    return mapWorkspaceRow(row);
  }

  /** `workspace_list` — optionally scoped to one Product; ordered `createdAt` ascending, then `uuid` ascending. */
  listWorkspaces(filter: { product_id?: string } = {}): Workspace[] {
    const rows = (
      filter.product_id
        ? this.db.prepare(`SELECT * FROM workspaces WHERE product_id = ? ORDER BY created_at ASC, uuid ASC`).all(filter.product_id)
        : this.db.prepare(`SELECT * FROM workspaces ORDER BY created_at ASC, uuid ASC`).all()
    ) as unknown as WorkspaceRow[];
    return rows.map(mapWorkspaceRow);
  }

  /** `resource_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listResources(filter: { workspace_id: string }): Resource[] {
    const rows = this.db
      .prepare(`SELECT * FROM resources WHERE workspace_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(filter.workspace_id) as unknown as ResourceRow[];
    return rows.map(mapResourceRow);
  }

  /** `initiative_get` — `uuid` or `human_key`; both resolve the same record. */
  getInitiative(lookup: { uuid?: string; human_key?: string }): Initiative {
    const row = this.findInitiativeRow(lookup.uuid, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    return mapInitiativeRow(row);
  }

  /** `initiative_list` — optionally scoped by Product and/or status; ordered `createdAt` descending, then `uuid` ascending. */
  listInitiatives(filter: { product_id?: string; status?: InitiativeStatus } = {}): Initiative[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.product_id) {
      clauses.push('product_id = ?');
      params.push(filter.product_id);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM initiatives ${where} ORDER BY created_at DESC, uuid ASC`)
      .all(...params) as unknown as InitiativeRow[];
    return rows.map(mapInitiativeRow);
  }

  /** `initiative_relations` — relations involving the Initiative in either direction; direction is preserved. */
  listInitiativeRelations(filter: { initiative_id: string }): InitiativeRelation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM initiative_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at ASC, from_id ASC, to_id ASC, type ASC`,
      )
      .all(filter.initiative_id, filter.initiative_id) as unknown as RelationRow[];
    return rows.map(mapRelationRow);
  }

  /** Resume join: each relation involving the Initiative paired with the *other* Initiative it names. */
  getRelatedInitiatives(initiativeId: string): RelatedInitiativeRead[] {
    const relations = this.listInitiativeRelations({ initiative_id: initiativeId });
    const results = relations.map((relation) => {
      const otherId = relation.from_id === initiativeId ? relation.to_id : relation.from_id;
      const row = this.findInitiativeRow(otherId, undefined);
      if (!row) {
        throw new NotFoundError({ entity_type: 'Initiative', lookup: otherId });
      }
      return { relation, initiative: mapInitiativeRow(row) };
    });
    return results.sort((a, b) => compareCreatedAtThenUuid(a.initiative, b.initiative));
  }

  /** Resume join: the Initiative's Workspace links, each joined with its Workspace and that Workspace's Resources. */
  getInitiativeWorkspaceLinks(initiativeId: string): InitiativeWorkspaceLinkRead[] {
    const rows = this.db
      .prepare(`SELECT * FROM initiative_workspace_links WHERE initiative_id = ?`)
      .all(initiativeId) as unknown as LinkRow[];
    const results = rows.map((row) => {
      const workspaceRow = this.db.prepare(`SELECT * FROM workspaces WHERE uuid = ?`).get(row.workspace_id) as
        | WorkspaceRow
        | undefined;
      if (!workspaceRow) {
        throw new NotFoundError({ entity_type: 'Workspace', lookup: row.workspace_id });
      }
      const workspace = mapWorkspaceRow(workspaceRow);
      return { role: row.role, workspace, resources: this.listResources({ workspace_id: workspace.uuid }) };
    });
    return results.sort((a, b) => compareCreatedAtThenUuid(a.workspace, b.workspace));
  }

  /** `initiative_task_get` — `uuid`. */
  getInitiativeTask(lookup: { uuid: string }): Task {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE uuid = ?`).get(lookup.uuid) as TaskRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'Task', lookup: lookup.uuid });
    }
    return mapTaskRow(row);
  }

  /** `initiative_task_list` — non-terminal Tasks first, then terminal Tasks; each group by `createdAt` ascending, then `uuid` ascending. */
  listInitiativeTasks(filter: { initiative_id: string }): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE initiative_id = ?
         ORDER BY CASE WHEN status IN ('completed', 'cancelled') THEN 1 ELSE 0 END ASC, created_at ASC, uuid ASC`,
      )
      .all(filter.initiative_id) as unknown as TaskRow[];
    return rows.map(mapTaskRow);
  }

  /** Resume join: Task counts by status for the Initiative — every `TaskStatus` key present, defaulting to `0`. */
  countInitiativeTasksByStatus(initiativeId: string): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      open: 0,
      claimed: 0,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0,
    };
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM tasks WHERE initiative_id = ? GROUP BY status`)
      .all(initiativeId) as Array<{ status: TaskStatus; count: number }>;
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  /** `artifact_get` — `uuid`. */
  getArtifact(lookup: { uuid: string }): ArtifactRef {
    const row = this.db.prepare(`SELECT * FROM artifact_refs WHERE uuid = ?`).get(lookup.uuid) as ArtifactRefRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'ArtifactRef', lookup: lookup.uuid });
    }
    return mapArtifactRefRow(row);
  }

  /** Resume join: the Initiative's ArtifactRefs, ordered by `createdAt` ascending, then `uuid` ascending. */
  listInitiativeArtifacts(initiativeId: string): ArtifactRef[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifact_refs WHERE initiative_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(initiativeId) as unknown as ArtifactRefRow[];
    return rows.map(mapArtifactRefRow);
  }

  /** Resume join: the newest `limit` Events for the Initiative, ordered by `event_sequence` descending. */
  listRecentEvents(filter: { initiative_id: string; limit: number }): Event[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE initiative_id = ? ORDER BY event_sequence DESC LIMIT ?`)
      .all(filter.initiative_id, filter.limit) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  /** Resume join: the total Event count for the Initiative (independent of any `event_limit` window). */
  countInitiativeEvents(initiativeId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE initiative_id = ?`).get(initiativeId) as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  // ---------------------------------------------------------------------
  // Phase A1 reads (Task I-5) — every remaining frozen get/list operation,
  // plus the joined read methods `initiativeResume` (Task I-6/I-8) composes
  // from. `getDecision` and `getVerificationRun` are implemented above
  // (Task I-3/I-4, "Phase A1 reads needed to verify..."); every other Phase
  // A1 read is added here, with the frozen scoped selectors and pinned
  // deterministic orderings from SPEC-002's "frozen read-only-operation
  // contract" and resume-ordering paragraphs.
  // ---------------------------------------------------------------------

  /** `requirement_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getRequirement(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Requirement {
    const row = this.findRequirementRow(lookup.uuid, lookup.initiative_id, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Requirement', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    return mapRequirementRow(row);
  }

  /** `requirement_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listRequirements(filter: { initiative_id: string }): Requirement[] {
    const rows = this.db
      .prepare(`SELECT * FROM requirements WHERE initiative_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(filter.initiative_id) as unknown as RequirementRow[];
    return rows.map(mapRequirementRow);
  }

  /** `acceptance_criterion_get` — `uuid`, or `(requirement_id, human_key)`. Throws `not_found`. */
  getAcceptanceCriterion(lookup: { uuid?: string; requirement_id?: string; human_key?: string }): AcceptanceCriterion {
    const row = this.findAcceptanceCriterionRow(lookup.uuid, lookup.requirement_id, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'AcceptanceCriterion', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    return mapAcceptanceCriterionRow(row);
  }

  /** `acceptance_criterion_list` — scoped to one Requirement or Initiative; ordered `createdAt` ascending, then `uuid` ascending. */
  listAcceptanceCriteria(filter: { requirement_id?: string; initiative_id?: string }): AcceptanceCriterion[] {
    const requirementId = filter.requirement_id;
    const initiativeId = filter.initiative_id;
    const rows = (
      requirementId
        ? this.db
            .prepare(`SELECT * FROM acceptance_criteria WHERE requirement_id = ? ORDER BY created_at ASC, uuid ASC`)
            .all(requirementId)
        : this.db
            .prepare(
              `SELECT ac.* FROM acceptance_criteria ac
               JOIN requirements r ON r.uuid = ac.requirement_id
               WHERE r.initiative_id = ?
               ORDER BY ac.created_at ASC, ac.uuid ASC`,
            )
            .all(initiativeId as string)
    ) as unknown as AcceptanceCriterionRow[];
    return rows.map(mapAcceptanceCriterionRow);
  }

  /** `decision_list` — status group `'open'`, `'decided'`, `'superseded'`, then `createdAt` ascending, then `uuid` ascending. Identical to the resume ordering. */
  listDecisions(filter: { initiative_id: string }): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions WHERE initiative_id = ?
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'decided' THEN 1 ELSE 2 END ASC, created_at ASC, uuid ASC`,
      )
      .all(filter.initiative_id) as unknown as DecisionRow[];
    return rows.map(mapDecisionRow);
  }

  /** `evidence_get` — `uuid`, or `(initiative_id, locator)`. Throws `not_found`. */
  getEvidence(lookup: { uuid?: string; initiative_id?: string; locator?: string }): Evidence {
    const row = this.findEvidenceRow(lookup.uuid, lookup.initiative_id, lookup.locator);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Evidence', lookup: lookup.uuid ?? lookup.locator ?? '' });
    }
    return mapEvidenceRow(row);
  }

  /** `evidence_list` — ordered `createdAt` ascending, then `uuid` ascending. */
  listEvidence(filter: { initiative_id: string }): Evidence[] {
    const rows = this.db
      .prepare(`SELECT * FROM evidence WHERE initiative_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(filter.initiative_id) as unknown as EvidenceRow[];
    return rows.map(mapEvidenceRow);
  }

  /**
   * `evidence_links_list` — scoped to one Evidence or one link target (`target_type` + `target_id` together);
   * ordered `createdAt` ascending, then the composite identity (`evidence_id`, `target_type`, `target_id`)
   * ascending — EvidenceLink's composite identity is the tie-breaker since it has no `uuid`.
   */
  listEvidenceLinks(filter: {
    evidence_id?: string;
    target_type?: EvidenceLinkTargetType;
    target_id?: string;
  }): EvidenceLink[] {
    const evidenceId = filter.evidence_id;
    const targetType = filter.target_type;
    const targetId = filter.target_id;
    const rows = (
      evidenceId
        ? this.db
            .prepare(
              `SELECT * FROM evidence_links WHERE evidence_id = ?
               ORDER BY created_at ASC, evidence_id ASC, target_type ASC, target_id ASC`,
            )
            .all(evidenceId)
        : this.db
            .prepare(
              `SELECT * FROM evidence_links WHERE target_type = ? AND target_id = ?
               ORDER BY created_at ASC, evidence_id ASC, target_type ASC, target_id ASC`,
            )
            .all(targetType as string, targetId as string)
    ) as unknown as EvidenceLinkRow[];
    return rows.map(mapEvidenceLinkRow);
  }

  /** `risk_get` — `uuid`, or `(initiative_id, human_key)`. Throws `not_found`. */
  getRisk(lookup: { uuid?: string; initiative_id?: string; human_key?: string }): Risk {
    const row = this.findRiskRow(lookup.uuid, lookup.initiative_id, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Risk', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    return mapRiskRow(row);
  }

  /** `risk_list` — ordered `createdAt` ascending, then `uuid` ascending (the plain list order — distinct from the resume-specific risk ordering). */
  listRisks(filter: { initiative_id: string }): Risk[] {
    const rows = this.db
      .prepare(`SELECT * FROM risks WHERE initiative_id = ? ORDER BY created_at ASC, uuid ASC`)
      .all(filter.initiative_id) as unknown as RiskRow[];
    return rows.map(mapRiskRow);
  }

  /**
   * `verification_list` — for an `initiative_id` selector: `acceptance_criterion_id` ascending, then `createdAt`
   * descending, then `uuid` descending. For an `acceptance_criterion_id` selector: `createdAt` descending, then
   * `uuid` descending.
   */
  listVerificationRuns(filter: { acceptance_criterion_id?: string; initiative_id?: string }): VerificationRun[] {
    const acceptanceCriterionId = filter.acceptance_criterion_id;
    const initiativeId = filter.initiative_id;
    const rows = (
      acceptanceCriterionId
        ? this.db
            .prepare(`SELECT * FROM verification_runs WHERE acceptance_criterion_id = ? ORDER BY created_at DESC, uuid DESC`)
            .all(acceptanceCriterionId)
        : this.db
            .prepare(
              `SELECT * FROM verification_runs WHERE initiative_id = ?
               ORDER BY acceptance_criterion_id ASC, created_at DESC, uuid DESC`,
            )
            .all(initiativeId as string)
    ) as unknown as VerificationRunRow[];
    return rows.map(mapVerificationRunRow);
  }

  /** Resume join: every Requirement for the Initiative, each with its ordered Acceptance Criteria. */
  getRequirementsWithCriteria(initiativeId: string): RequirementWithCriteriaRead[] {
    return this.listRequirements({ initiative_id: initiativeId }).map((requirement) => ({
      requirement,
      acceptance_criteria: this.listAcceptanceCriteria({ requirement_id: requirement.uuid }),
    }));
  }

  /**
   * Resume join: Risks ordered open-first (severity high to low within the open group), then all other statuses;
   * within each group, `createdAt` ascending, then `uuid` ascending. Distinct from `listRisks`.
   */
  getResumeRisks(initiativeId: string): Risk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM risks WHERE initiative_id = ?
         ORDER BY
           CASE WHEN status = 'open' THEN 0 ELSE 1 END ASC,
           CASE WHEN status = 'open' THEN CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ELSE 0 END ASC,
           created_at ASC,
           uuid ASC`,
      )
      .all(initiativeId) as unknown as RiskRow[];
    return rows.map(mapRiskRow);
  }

  /**
   * Resume join: one entry per Acceptance Criterion (within the Requirements-then-Acceptance-Criteria order) that
   * has any Verification Run, with `latest` selected by `createdAt` descending, then `uuid` descending.
   */
  getLatestVerificationRuns(initiativeId: string): LatestVerificationRead[] {
    // One query for the whole Initiative, not one per Acceptance Criterion (audit M1-16). The
    // window function picks each criterion's newest run under the SAME ordering the per-criterion
    // query used, so the selected row is identical — this is a shape change, not a semantic one.
    // Criteria are still visited in requirement order so the returned sequence is unchanged.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT vr.*, ROW_NUMBER() OVER (
             PARTITION BY vr.acceptance_criterion_id ORDER BY vr.created_at DESC, vr.uuid DESC
           ) AS rank_in_criterion
           FROM verification_runs vr
           WHERE vr.initiative_id = ?
         ) WHERE rank_in_criterion = 1`,
      )
      .all(initiativeId) as unknown as VerificationRunRow[];
    const latestByCriterion = new Map(rows.map((row) => [row.acceptance_criterion_id, mapVerificationRunRow(row)]));

    const results: LatestVerificationRead[] = [];
    for (const { acceptance_criteria } of this.getRequirementsWithCriteria(initiativeId)) {
      for (const criterion of acceptance_criteria) {
        const latest = latestByCriterion.get(criterion.uuid);
        if (latest) results.push({ acceptance_criterion_id: criterion.uuid, latest });
      }
    }
    return results;
  }

  /** Resume count: total Requirements for the Initiative. */
  countRequirements(initiativeId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM requirements WHERE initiative_id = ?`).get(initiativeId) as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  /** Resume count: total Acceptance Criteria across the Initiative's Requirements. */
  countAcceptanceCriteria(initiativeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM acceptance_criteria ac
         JOIN requirements r ON r.uuid = ac.requirement_id
         WHERE r.initiative_id = ?`,
      )
      .get(initiativeId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Resume count: Decisions with `status: 'open'`. */
  countOpenDecisions(initiativeId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM decisions WHERE initiative_id = ? AND status = 'open'`)
      .get(initiativeId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Resume count: Risks with `status: 'open'`. */
  countOpenRisks(initiativeId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM risks WHERE initiative_id = ? AND status = 'open'`)
      .get(initiativeId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Resume count: total Evidence for the Initiative. */
  countEvidence(initiativeId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM evidence WHERE initiative_id = ?`).get(initiativeId) as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  /** Resume count: Verification Run counts by state — every `VerificationState` key present, defaulting to `0`. */
  countVerificationByState(initiativeId: string): Record<VerificationState, number> {
    const counts = Object.fromEntries(VERIFICATION_STATES.map((state) => [state, 0])) as Record<VerificationState, number>;
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS count FROM verification_runs WHERE initiative_id = ? GROUP BY state`)
      .all(initiativeId) as Array<{ state: VerificationState; count: number }>;
    for (const row of rows) {
      counts[row.state] = Number(row.count);
    }
    return counts;
  }

  /** Dispatches one validated mutating request to its write handler. Runs inside the caller's open transaction. */
  private applyMutation(
    request: InitiativeMutationRequest,
    /** Pre-executed `verification_run` outcome; see `execute()` (audit M1-3). */
    preRunVerification?: VerificationCommandOutcome,
  ): InitiativeRecordEntity {
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
      // SPEC-003 Phase B — Task claim/transition operations (FR-8, FR-9).
      case 'initiative_task_claim':
        return this.mutateInitiativeTaskClaim(request.input, request.expected_revision, request.provenance);
      case 'initiative_task_release':
        return this.mutateInitiativeTaskRelease(request.input, request.expected_revision, request.provenance);
      case 'initiative_task_complete':
        return this.mutateInitiativeTaskComplete(request.input, request.expected_revision, request.provenance);
      case 'initiative_task_execution':
        return this.mutateInitiativeTaskExecution(request.input, request.expected_revision, request.provenance);
      case 'artifact_register':
        return this.mutateArtifactRegister(request.input, request.expected_revision, request.provenance);
      // Phase A1 — professional record and verification ledger (SPEC-002 FR-3).
      case 'requirement_add':
        return this.mutateRequirementAdd(request.input, request.expected_revision, request.provenance);
      case 'acceptance_criterion_add':
        return this.mutateAcceptanceCriterionAdd(request.input, request.expected_revision, request.provenance);
      case 'decision_record':
        return this.mutateDecisionRecord(request.input, request.expected_revision, request.provenance);
      case 'decision_supersede':
        return this.mutateDecisionSupersede(request.input, request.expected_revision, request.provenance);
      case 'evidence_add':
        return this.mutateEvidenceAdd(request.input, request.expected_revision, request.provenance);
      case 'evidence_link':
        return this.mutateEvidenceLink(request.input, request.expected_revision, request.provenance);
      case 'risk_add':
        return this.mutateRiskAdd(request.input, request.expected_revision, request.provenance);
      case 'risk_status':
        return this.mutateRiskStatus(request.input, request.expected_revision, request.provenance);
      case 'verification_record':
        return this.mutateVerificationRecord(request.input, request.expected_revision, request.provenance);
      // SPEC-004 Lifecycle Engine (FR-2 through FR-7).
      case 'initiative_phase_enter':
        return this.mutateInitiativePhaseEnter(request.input, request.expected_revision, request.provenance);
      case 'initiative_phase_satisfy':
        return this.mutateInitiativePhaseSatisfy(request.input, request.expected_revision, request.provenance);
      case 'initiative_phase_reopen':
        return this.mutateInitiativePhaseReopen(request.input, request.expected_revision, request.provenance);
      case 'initiative_phase_skip':
        return this.mutateInitiativePhaseSkip(request.input, request.expected_revision, request.provenance);
      case 'initiative_focus_set':
        return this.mutateInitiativeFocusSet(request.input, request.expected_revision, request.provenance);
      case 'initiative_set_lifecycle_contract':
        return this.mutateInitiativeSetLifecycleContract(request.input, request.expected_revision, request.provenance);
      // SPEC-005 Method Registry (FR-5) — the sole Task Method mutation.
      case 'initiative_task_set_method':
        return this.mutateInitiativeTaskSetMethod(request.input, request.expected_revision, request.provenance);
      // SPEC-006 Business intake (← AC-1.4, AC-1.5, AC-1.7) — the confirmed-draft
      // composite mutation: one atomic transaction over several entity creates.
      case 'initiative_bootstrap':
        return this.mutateInitiativeBootstrap(request.input, request.expected_revision, request.provenance);
      // SPEC-007 Delivery Layer (Task I-3, ← AC-1.5, AC-1.6): the first Deliverable mutations —
      // one transactional `store.execute()` call each, same pattern as every mutation above.
      case 'deliverable_define':
        return this.mutateDeliverableDefine(request.input, request.expected_revision, request.provenance);
      case 'deliverable_attach_artifact':
        return this.mutateDeliverableAttachArtifact(request.input, request.expected_revision, request.provenance);
      // SPEC-007 Delivery Layer (Task I-4, ← AC-1.6, AC-1.7, AC-1.8, AC-1.9): computed
      // validation and delivery history — same one-transactional-call pattern as every
      // mutation above.
      case 'deliverable_validate':
        return this.mutateDeliverableValidate(request.input, request.expected_revision, request.provenance);
      case 'deliverable_deliver':
        return this.mutateDeliverableDeliver(request.input, request.expected_revision, request.provenance);
      // SPEC-007 Delivery Layer (Task I-6, ← AC-1.7): the maintainer-confirmed human-approval
      // mutation — same one-transactional-call pattern as every mutation above.
      case 'deliverable_approve':
        return this.mutateDeliverableApprove(request.input, request.expected_revision, request.provenance);
      // MMA Next gap-closure (§15 application surface, §21 success criterion 12): verification
      // execution, packaging assembly, and Initiative import — same one-transactional-call
      // pattern as every mutation above. `initiative_export` is not here: it is a dedicated
      // read (`InitiativeRecordRuntime.initiativeExport`), like `initiative_resume`.
      case 'verification_run':
        return this.mutateVerificationRun(request.input, request.expected_revision, request.provenance, preRunVerification);
      case 'deliverable_package':
        return this.mutateDeliverablePackage(request.input, request.expected_revision, request.provenance);
      case 'initiative_import':
        return this.mutateInitiativeImport(request.input, request.expected_revision, request.provenance);
      default: {
        // The switch above is exhaustive over `InitiativeMutationRequest`;
        // `request` narrows to `never` here. This branch only guards a future
        // union member added without a matching case — casting `never` to an
        // object shape is always allowed, so this still throws the correct
        // typed error at runtime instead of a type error at compile time.
        const unhandled = request as { operation: string };
        throw new InvalidRequestError({
          field_errors: { operation: ['unsupported mutation operation'] },
          message: `invalid_request: unsupported mutation operation ${JSON.stringify(unhandled.operation)}`,
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

  /** Throws typed `invalid_request` (a "duplicate identity write") if a row already exists in `table` matching every `columns` entry. */
  private requireUnique(table: string, columns: Record<string, string>, entityType: string, identityLabel: string): void {
    const keys = Object.keys(columns);
    const where = keys.map((key) => `${key} = ?`).join(' AND ');
    const row = this.db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...keys.map((key) => columns[key])) as
      | Record<string, unknown>
      | undefined;
    if (row) {
      throw new InvalidRequestError({
        field_errors: { [identityLabel]: ['already in use'] },
        message: `invalid_request: ${entityType} with ${identityLabel} ${JSON.stringify(columns)} already exists`,
      });
    }
  }

  /** Throws typed `invalid_request` (a "foreign-key failure") if `uuid` is not a row in `table`. */
  private requireExists(table: string, uuid: string, field: string, entityType: string): void {
    const row = this.db.prepare(`SELECT 1 FROM ${table} WHERE uuid = ? LIMIT 1`).get(uuid) as Record<string, unknown> | undefined;
    if (!row) {
      throw new InvalidRequestError({
        field_errors: { [field]: [`references a nonexistent ${entityType}`] },
        message: `invalid_request: ${field} ${uuid} does not reference an existing ${entityType}`,
      });
    }
  }

  /** Returns the full row for `table.uuid = uuid`, or throws typed `invalid_request` (a "foreign-key failure") naming `field`/`entityType`. */
  private requireRow<T>(table: string, uuid: string, field: string, entityType: string): T {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid) as T | undefined;
    if (!row) {
      throw new InvalidRequestError({
        field_errors: { [field]: [`references a nonexistent ${entityType}`] },
        message: `invalid_request: ${field} ${uuid} does not reference an existing ${entityType}`,
      });
    }
    return row;
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

  /**
   * Allocates the next value of a scoped Phase A1 counter (`REQ-<n>` per
   * Initiative, `AC-<n>` per Requirement, `D-<n>` and `RISK-<n>` per
   * Initiative — SPEC-002 "Data model"), reusing the generic version-1
   * `counters(name, value)` table at a scoped key such as
   * `requirement_human_key:<initiative_id>`. Unlike `MMA-INIT-<n>`, these
   * human keys are NOT zero-padded (the frozen pattern is exactly `<prefix>-<n>`).
   * Runs inside the caller's open write transaction, so two concurrent creates
   * for the same scope never receive the same human key.
   */
  private allocateScopedHumanKey(counterName: string, prefix: string): string {
    const row = this.db.prepare(`SELECT value FROM counters WHERE name = ?`).get(counterName) as
      | { value?: number }
      | undefined;
    const next = (row?.value ?? 0) + 1;
    if (row) {
      this.db.prepare(`UPDATE counters SET value = ? WHERE name = ?`).run(next, counterName);
    } else {
      this.db.prepare(`INSERT INTO counters (name, value) VALUES (?, ?)`).run(counterName, next);
    }
    return `${prefix}-${next}`;
  }

  /** `decision_supersede`/`decision_get` old-Decision lookup: `uuid` alone, or `(initiative_id, human_key)` together. */
  private findDecisionRow(uuid?: string, initiativeId?: string, humanKey?: string): DecisionRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM decisions WHERE uuid = ?`).get(uuid) as DecisionRow | undefined;
    }
    if (initiativeId && humanKey) {
      return this.db.prepare(`SELECT * FROM decisions WHERE initiative_id = ? AND human_key = ?`).get(
        initiativeId,
        humanKey,
      ) as DecisionRow | undefined;
    }
    return undefined;
  }

  /** `risk_status`/`risk_get` lookup: `uuid` alone, or `(initiative_id, human_key)` together. */
  private findRiskRow(uuid?: string, initiativeId?: string, humanKey?: string): RiskRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM risks WHERE uuid = ?`).get(uuid) as RiskRow | undefined;
    }
    if (initiativeId && humanKey) {
      return this.db.prepare(`SELECT * FROM risks WHERE initiative_id = ? AND human_key = ?`).get(
        initiativeId,
        humanKey,
      ) as RiskRow | undefined;
    }
    return undefined;
  }

  /** `requirement_get` lookup: `uuid` alone, or `(initiative_id, human_key)` together. */
  private findRequirementRow(uuid?: string, initiativeId?: string, humanKey?: string): RequirementRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM requirements WHERE uuid = ?`).get(uuid) as RequirementRow | undefined;
    }
    if (initiativeId && humanKey) {
      return this.db.prepare(`SELECT * FROM requirements WHERE initiative_id = ? AND human_key = ?`).get(
        initiativeId,
        humanKey,
      ) as RequirementRow | undefined;
    }
    return undefined;
  }

  /** `acceptance_criterion_get` lookup: `uuid` alone, or `(requirement_id, human_key)` together. */
  private findAcceptanceCriterionRow(
    uuid?: string,
    requirementId?: string,
    humanKey?: string,
  ): AcceptanceCriterionRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM acceptance_criteria WHERE uuid = ?`).get(uuid) as
        | AcceptanceCriterionRow
        | undefined;
    }
    if (requirementId && humanKey) {
      return this.db.prepare(`SELECT * FROM acceptance_criteria WHERE requirement_id = ? AND human_key = ?`).get(
        requirementId,
        humanKey,
      ) as AcceptanceCriterionRow | undefined;
    }
    return undefined;
  }

  /** `evidence_get` lookup: `uuid` alone, or `(initiative_id, locator)` together. */
  private findEvidenceRow(uuid?: string, initiativeId?: string, locator?: string): EvidenceRow | undefined {
    if (uuid) {
      return this.db.prepare(`SELECT * FROM evidence WHERE uuid = ?`).get(uuid) as EvidenceRow | undefined;
    }
    if (initiativeId && locator) {
      return this.db.prepare(`SELECT * FROM evidence WHERE initiative_id = ? AND locator = ?`).get(
        initiativeId,
        locator,
      ) as EvidenceRow | undefined;
    }
    return undefined;
  }

  private mutateProductCreate(input: ProductCreateInput, expectedRevision: number, provenance: ProvenanceInput): Product {
    this.requireCreateRevision(expectedRevision, 'Product');
    this.requireUnique('products', { slug: input.slug }, 'Product', 'slug');
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
    this.requireExists('products', input.product_id, 'product_id', 'Product');
    this.requireUnique('workspaces', { product_id: input.product_id, slug: input.slug }, 'Workspace', 'slug');
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
    this.requireExists('workspaces', input.workspace_id, 'workspace_id', 'Workspace');
    this.requireUnique(
      'resources',
      { workspace_id: input.workspace_id, canonical_locator: input.canonical_locator },
      'Resource',
      'canonical_locator',
    );
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

  /**
   * `uuidOverride` (SPEC-006 Task I-3): `initiative_bootstrap` pre-generates the Initiative's
   * `uuid` during its own validation phase — before this method's write — so a rejected
   * cross-Product existing-Workspace check can construct `CrossProductWorkspaceLinkError` with
   * the same real identifier the row is later created with. Every other caller omits it and gets
   * a freshly generated `uuid`, unchanged from before this parameter existed.
   */
  private mutateInitiativeCreate(
    input: InitiativeCreateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
    uuidOverride?: string,
  ): Initiative {
    this.requireCreateRevision(expectedRevision, 'Initiative');
    this.requireExists('products', input.product_id, 'product_id', 'Product');
    // SPEC-004 FR-7: omitted `lifecycle_contract` defaults to the seeded built-in contract; an
    // explicit id must already be registered (never `null` here — `null` is reserved for the
    // later `initiative_set_lifecycle_contract` clearing mutation, and Zod already rejects it).
    const lifecycleContract = input.lifecycle_contract ?? DEFAULT_LIFECYCLE_CONTRACT_ID;
    const contractRow = this.db.prepare(`SELECT 1 FROM lifecycle_contracts WHERE id = ?`).get(lifecycleContract);
    if (!contractRow) {
      throw new UnknownLifecycleContractError({ lifecycle_contract: lifecycleContract });
    }
    const uuid = uuidOverride ?? randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateInitiativeHumanKey();
    this.db
      .prepare(
        `INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision, focus_phase, lifecycle_contract) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(uuid, humanKey, input.product_id, input.title, input.goal, input.status, input.outcome, now, now, lifecycleContract);
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
      focus_phase: null,
      lifecycle_contract: lifecycleContract,
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
      focus_phase: row.focus_phase,
      lifecycle_contract: row.lifecycle_contract,
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
    this.requireUnique(
      'initiative_workspace_links',
      { initiative_id: input.initiative_id, workspace_id: input.workspace_id, role: input.role },
      'InitiativeWorkspaceLink',
      'role',
    );
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
    this.requireUnique(
      'initiative_relations',
      { from_id: input.from_id, to_id: input.to_id, type: input.type },
      'InitiativeRelation',
      'type',
    );
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
    // SPEC-005 Method Registry (FR-5): a non-null `method` must already be registered —
    // `getMethodOrThrow` throws `unknown_method` for anything else. `undefined` (omitted)
    // maps to a stored `null`, never inferred from title/goal/workspaces.
    const method = input.method ?? null;
    if (method !== null) {
      this.getMethodOrThrow(method);
    }
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const executionRefs = input.executionRefs ?? [];
    this.db
      .prepare(
        `INSERT INTO tasks (uuid, initiative_id, title, goal, status, outcome, workspace_ids, resource_ids, execution_refs, created_at, updated_at, revision, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
        method,
      );
    const task: Task = {
      uuid,
      initiative_id: input.initiative_id,
      title: input.title,
      goal: input.goal,
      status: input.status,
      outcome: input.outcome,
      claimed_by: null,
      workspace_ids: input.workspace_ids,
      resource_ids: input.resource_ids,
      executionRefs,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      method,
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

  /**
   * `initiative_task_set_method` (SPEC-005 FR-5): sets or clears (`null`) a Task's Method
   * under the standard `expected_revision` compare-and-swap applied to the TASK row (not the
   * Initiative row — `input.initiative` only scopes the lookup and confirms the Task belongs
   * to that Initiative). A non-null `method` must already be registered — `getMethodOrThrow`
   * throws `unknown_method` otherwise, before any write. Emits exactly one `task_method_set`
   * Event per successful call; idempotency replay (handled by `execute()`) produces no second.
   */
  private mutateInitiativeTaskSetMethod(
    input: InitiativeTaskSetMethodInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Task {
    const initiativeRow = this.findInitiativeRow(input.initiative.uuid, input.initiative.human_key);
    if (!initiativeRow) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: input.initiative.uuid ?? input.initiative.human_key ?? '' });
    }
    const row = this.requireTaskRow(input.task.uuid);
    if (row.initiative_id !== initiativeRow.uuid) {
      throw new NotFoundError({ entity_type: 'Task', lookup: input.task.uuid });
    }
    this.requireTaskRevision(row, expectedRevision);
    if (input.method !== null) {
      this.getMethodOrThrow(input.method);
    }
    const previousMethod = row.method ?? null;
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE tasks SET method = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.method, now, nextRevision, row.uuid);
    const task: Task = { ...mapTaskRow(row), method: input.method, updatedAt: now, revision: nextRevision };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'task_method_set',
      payload: { previous_method: previousMethod, new_method: input.method },
      provenance,
    });
    return task;
  }

  /** `uuid`-only Task lookup shared by the four claim/transition mutations below. Throws `not_found`. */
  private requireTaskRow(uuid: string): TaskRow {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE uuid = ?`).get(uuid) as TaskRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity_type: 'Task', lookup: uuid });
    }
    return row;
  }

  private requireTaskRevision(row: TaskRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Task',
        entity_id: row.uuid,
        expected_revision: expectedRevision,
        actual_revision: row.revision,
      });
    }
  }

  /**
   * `initiative_task_claim` (SPEC-003 FR-8, FR-9): `open → claimed` only,
   * setting `claimed_by` to `provenance.actor_id`. Any other source status
   * throws `task_not_claimable`.
   */
  private mutateInitiativeTaskClaim(input: InitiativeTaskClaimInput, expectedRevision: number, provenance: ProvenanceInput): Task {
    const row = this.requireTaskRow(input.uuid);
    this.requireTaskRevision(row, expectedRevision);
    if (row.status !== 'open') {
      throw new TaskNotClaimableError({ task_id: row.uuid, status: row.status });
    }
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    const claimedBy = provenance.actor_id;
    this.db
      .prepare(`UPDATE tasks SET status = 'claimed', claimed_by = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(claimedBy, now, nextRevision, row.uuid);
    const task: Task = { ...mapTaskRow(row), status: 'claimed', claimed_by: claimedBy, updatedAt: now, revision: nextRevision };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'task_claimed',
      payload: { uuid: row.uuid, initiative_id: row.initiative_id, claimed_by: claimedBy },
      provenance,
    });
    return task;
  }

  /**
   * `initiative_task_release` (SPEC-003 FR-8, FR-9): `claimed | in_progress → open` only,
   * resetting `claimed_by` to `null`. An ownership mismatch throws `task_claim_conflict`
   * UNLESS `provenance.actor_type === 'human'` (the deliberate stale-claim override).
   */
  private mutateInitiativeTaskRelease(
    input: InitiativeTaskReleaseInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Task {
    const row = this.requireTaskRow(input.uuid);
    this.requireTaskRevision(row, expectedRevision);
    if (row.status !== 'claimed' && row.status !== 'in_progress') {
      throw new InvalidTaskTransitionError({ task_id: row.uuid, from_status: row.status, to_status: 'open' });
    }
    if (row.claimed_by !== null && row.claimed_by !== provenance.authorized_by && provenance.actor_type !== 'human') {
      throw new TaskClaimConflictError({ task_id: row.uuid, claimed_by: row.claimed_by, authorized_by: provenance.authorized_by });
    }
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE tasks SET status = 'open', claimed_by = NULL, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(now, nextRevision, row.uuid);
    const task: Task = { ...mapTaskRow(row), status: 'open', claimed_by: null, updatedAt: now, revision: nextRevision };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'task_released',
      payload: { uuid: row.uuid, initiative_id: row.initiative_id },
      provenance,
    });
    return task;
  }

  /**
   * `initiative_task_complete` (SPEC-003 FR-8, FR-9): `claimed | in_progress → completed` only,
   * requiring a non-null outcome (enforced by the input schema) and retaining the claimant.
   * An ownership mismatch throws `task_claim_conflict` — release's human override does not apply here.
   */
  private mutateInitiativeTaskComplete(
    input: InitiativeTaskCompleteInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Task {
    const row = this.requireTaskRow(input.uuid);
    this.requireTaskRevision(row, expectedRevision);
    if (row.status !== 'claimed' && row.status !== 'in_progress') {
      throw new InvalidTaskTransitionError({ task_id: row.uuid, from_status: row.status, to_status: 'completed' });
    }
    if (row.claimed_by !== null && row.claimed_by !== provenance.authorized_by) {
      throw new TaskClaimConflictError({ task_id: row.uuid, claimed_by: row.claimed_by, authorized_by: provenance.authorized_by });
    }
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE tasks SET status = 'completed', outcome = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.outcome, now, nextRevision, row.uuid);
    const task: Task = { ...mapTaskRow(row), status: 'completed', outcome: input.outcome, updatedAt: now, revision: nextRevision };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'task_completed',
      payload: { uuid: row.uuid, initiative_id: row.initiative_id, outcome: input.outcome },
      provenance,
    });
    return task;
  }

  /**
   * `initiative_task_execution` (SPEC-003 FR-8, FR-9): appends `execution_ref` once (idempotent
   * append), and — unless the Task is already `completed` or `cancelled` — optionally applies one
   * transition from the frozen FR-9 matrix (`TASK_EXECUTION_TRANSITIONS`); any unlisted (source →
   * target) pair throws `invalid_task_transition`. The one ownership-gated transition,
   * `claimed → in_progress`, requires `provenance.authorized_by === claimed_by` (same rule as FR-5
   * admission) and otherwise throws `task_claim_conflict`. A `completed` transition's non-null
   * outcome is enforced by the input schema.
   */
  private mutateInitiativeTaskExecution(
    input: InitiativeTaskExecutionInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Task {
    const row = this.requireTaskRow(input.uuid);
    this.requireTaskRevision(row, expectedRevision);
    if (row.status === 'completed' || row.status === 'cancelled') {
      throw new InvalidTaskTransitionError({
        task_id: row.uuid,
        from_status: row.status,
        to_status: input.transition ?? row.status,
      });
    }

    const existingRefs = JSON.parse(row.execution_refs ?? '[]') as string[];
    const nextRefs = existingRefs.includes(input.execution_ref) ? existingRefs : [...existingRefs, input.execution_ref];

    let nextStatus: TaskStatus = row.status;
    let nextOutcome = row.outcome;
    if (input.transition) {
      const permitted = TASK_EXECUTION_TRANSITIONS[row.status] ?? [];
      if (!permitted.includes(input.transition)) {
        throw new InvalidTaskTransitionError({ task_id: row.uuid, from_status: row.status, to_status: input.transition });
      }
      if (
        row.status === 'claimed' &&
        input.transition === 'in_progress' &&
        row.claimed_by !== null &&
        row.claimed_by !== provenance.authorized_by
      ) {
        throw new TaskClaimConflictError({ task_id: row.uuid, claimed_by: row.claimed_by, authorized_by: provenance.authorized_by });
      }
      nextStatus = input.transition;
      if (input.transition === 'completed') {
        nextOutcome = input.outcome ?? null;
      }
    }

    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE tasks SET status = ?, outcome = ?, execution_refs = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(nextStatus, nextOutcome, JSON.stringify(nextRefs), now, nextRevision, row.uuid);
    const task: Task = {
      ...mapTaskRow(row),
      status: nextStatus,
      outcome: nextOutcome,
      executionRefs: nextRefs,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Task',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'task_execution_recorded',
      payload: { uuid: row.uuid, initiative_id: row.initiative_id, execution_ref: input.execution_ref },
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

  // ---------------------------------------------------------------------
  // SPEC-007 Delivery Layer — the first Deliverable mutations (Task I-3, ←
  // AC-1.4, AC-1.5, AC-1.6). `deliverable_validate`/`deliverable_deliver`
  // (Task I-4) and `deliverable_approve` (Task I-6) are separate, later
  // mutations against the same `deliverables` row.
  // ---------------------------------------------------------------------

  /**
   * `deliverable_define` (← AC-1.4, AC-1.6): always a create (`expected_revision` must be 0 —
   * there is no create-or-update identity for a Deliverable, unlike `artifact_register`). Throws
   * `unknown_delivery_contract` for an unregistered `delivery_contract`, and `invalid_request` for
   * an Initiative that does not exist or a `target_type` that does not match the resolved
   * Delivery Contract's own `target_type` (AC-1.4's target/contract mismatch check). The new row
   * starts `validation_state: 'pending'` with an empty detail and a null `delivery_reference` —
   * `validation_state` is computed-only and not part of this input.
   */
  private mutateDeliverableDefine(
    input: DeliverableDefineInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Deliverable {
    this.requireCreateRevision(expectedRevision, 'Deliverable');
    this.requireExists('initiatives', input.initiative_id, 'initiative_id', 'Initiative');
    const contract = this.getDeliveryContractOrThrow(input.delivery_contract);
    if (contract.target_type !== input.target_type) {
      throw new InvalidRequestError({
        field_errors: {
          target_type: [
            `does not match Delivery Contract '${input.delivery_contract}' target_type '${contract.target_type}'`,
          ],
        },
        message:
          `invalid_request: target_type '${input.target_type}' does not match Delivery Contract ` +
          `'${input.delivery_contract}' target_type '${contract.target_type}'`,
      });
    }
    const uuid = randomUUID();
    const now = provenance.timestamp;
    this.db
      .prepare(
        `INSERT INTO deliverables (uuid, initiative_id, target_type, delivery_contract, validation_state, validation_detail, delivery_reference, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 'pending', '', NULL, ?, ?, 0)`,
      )
      .run(uuid, input.initiative_id, input.target_type, input.delivery_contract, now, now);
    const deliverable: Deliverable = {
      uuid,
      initiative_id: input.initiative_id,
      target_type: input.target_type,
      delivery_contract: input.delivery_contract,
      validation_state: 'pending',
      validation_detail: '',
      delivery_reference: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Deliverable',
      entity_id: uuid,
      initiative_id: input.initiative_id,
      event_type: 'deliverable_defined',
      payload: {
        uuid,
        initiative_id: input.initiative_id,
        target_type: input.target_type,
        delivery_contract: input.delivery_contract,
      },
      provenance,
    });
    return deliverable;
  }

  /**
   * `deliverable_attach_artifact` (← AC-1.5, AC-1.6): attaches an ArtifactRef to a Deliverable
   * under a caller-named `requirement` string — no membership is inferred from existing
   * Artifacts. `expected_revision` is checked (and, on success, incremented) against the
   * DELIVERABLE's own revision, not a revision on the membership row itself: `DeliverableArtifactMember`
   * carries no `revision` field (its identity is the composite `(deliverable_id, artifact_id,
   * requirement)`), so the owning Deliverable is the sole optimistic-concurrency anchor for this
   * mutation, the same role `Task.revision` plays for `initiative_task_execution`. Throws
   * `invalid_request` for an unknown Deliverable or Artifact, a requirement not declared by the
   * Deliverable's Delivery Contract, an Artifact outside the Deliverable's own Initiative
   * (cross-Initiative — AC-1.5), or a duplicate `(deliverable_id, artifact_id, requirement)`
   * identity.
   */
  private mutateDeliverableAttachArtifact(
    input: DeliverableAttachArtifactInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): DeliverableArtifactMember {
    const deliverableRow = this.requireDeliverableRow(input.deliverable_id);
    this.requireDeliverableRevision(deliverableRow, expectedRevision);
    const contract = this.getDeliveryContractOrThrow(deliverableRow.delivery_contract);
    if (!contract.requires.includes(input.requirement)) {
      throw new InvalidRequestError({
        field_errors: {
          requirement: [
            `is not declared by Delivery Contract '${deliverableRow.delivery_contract}'`,
          ],
        },
        message:
          `invalid_request: requirement '${input.requirement}' is not declared by Delivery Contract `
          + `'${deliverableRow.delivery_contract}'`,
      });
    }
    const artifactRow = this.requireRow<ArtifactRefRow>('artifact_refs', input.artifact_id, 'artifact_id', 'ArtifactRef');
    if (artifactRow.initiative_id !== deliverableRow.initiative_id) {
      throw new InvalidRequestError({
        field_errors: {
          artifact_id: [
            "references an ArtifactRef outside the Deliverable's own Initiative (cross-initiative)",
          ],
        },
        message: `invalid_request: cross-initiative Artifact ${input.artifact_id} may not attach to Deliverable ${input.deliverable_id}`,
      });
    }
    const existingMember = this.db
      .prepare(`SELECT 1 FROM deliverable_artifacts WHERE deliverable_id = ? AND artifact_id = ? AND requirement = ?`)
      .get(input.deliverable_id, input.artifact_id, input.requirement) as Record<string, unknown> | undefined;
    if (existingMember) {
      throw new InvalidRequestError({
        field_errors: {
          requirement: ['this Artifact is already attached to this Deliverable for this requirement (duplicate member identity)'],
        },
        message: `invalid_request: duplicate DeliverableArtifactMember identity (${input.deliverable_id}, ${input.artifact_id}, ${input.requirement})`,
      });
    }
    const now = provenance.timestamp;
    this.db
      .prepare(`INSERT INTO deliverable_artifacts (deliverable_id, artifact_id, requirement, created_at) VALUES (?, ?, ?, ?)`)
      .run(input.deliverable_id, input.artifact_id, input.requirement, now);
    const nextRevision = deliverableRow.revision + 1;
    this.db
      .prepare(`UPDATE deliverables SET updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(now, nextRevision, input.deliverable_id);
    const member = mapDeliverableArtifactRow({
      deliverable_id: input.deliverable_id,
      artifact_id: input.artifact_id,
      requirement: input.requirement,
      created_at: now,
    });
    this.writeEvent({
      entity_type: 'DeliverableArtifactMember',
      entity_id: `${input.deliverable_id}:${input.artifact_id}:${input.requirement}`,
      initiative_id: deliverableRow.initiative_id,
      event_type: 'deliverable_artifact_attached',
      payload: { deliverable_id: input.deliverable_id, artifact_id: input.artifact_id, requirement: input.requirement },
      provenance,
    });
    return member;
  }

  /**
   * `deliverable_validate` (← AC-1.6, AC-1.7, AC-1.9): computes `validation_state` from
   * requirement coverage combined with a registered adapter verdict (SPEC-007 FR-6, FR-8,
   * "Proposed design" validation sequence). Resolution order: (1) resolve the Delivery
   * Contract, (2) read membership and compute missing requirements, (3) resolve a
   * `TargetAdapter` by the Deliverable's own `target_type`, (4) if one is registered, call it
   * — inside a try/catch so a throw or a malformed `{ valid, detail }` result is caught BEFORE
   * any store write and rethrown as `target_adapter_validation_failed`, leaving the stored
   * validation fields, revision, and Events untouched — otherwise fall back to contract
   * completeness only and the exact detail string `'no adapter registered'`. The final
   * `valid`/`invalid` state requires BOTH complete coverage AND (when an adapter is
   * registered) a truthy adapter verdict.
   */
  private mutateDeliverableValidate(
    input: DeliverableValidateInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Deliverable {
    const deliverableRow = this.requireDeliverableRow(input.deliverable_id);
    this.requireDeliverableRevision(deliverableRow, expectedRevision);

    // Task I-6 (← AC-1.7): `human_approved` is a human decision recorded by the separate
    // `deliverable_approve` mutation, not a computed state — recomputing here would risk
    // silently overwriting that decision with a fresh 'valid'/'invalid' verdict the next time
    // someone calls `deliverable_validate`. Skip contract/adapter computation entirely, leave
    // `validation_state` unchanged, and record an explicit skipped-computation detail so both
    // the returned result and the persisted row make the skip visible.
    if (deliverableRow.validation_state === 'human_approved') {
      const now = provenance.timestamp;
      const nextRevision = deliverableRow.revision + 1;
      const detail = 'validation computation skipped: Deliverable is human_approved';
      this.db
        .prepare(`UPDATE deliverables SET validation_detail = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
        .run(detail, now, nextRevision, input.deliverable_id);
      const skipped: Deliverable = {
        ...mapDeliverableRow(deliverableRow),
        validation_detail: detail,
        updatedAt: now,
        revision: nextRevision,
      };
      this.writeEvent({
        entity_type: 'Deliverable',
        entity_id: input.deliverable_id,
        initiative_id: deliverableRow.initiative_id,
        event_type: 'deliverable_validated',
        payload: { uuid: input.deliverable_id, validation_state: 'human_approved', detail },
        provenance,
      });
      return skipped;
    }

    const contract = this.getDeliveryContractOrThrow(deliverableRow.delivery_contract);
    const memberRows = this.db
      .prepare(`SELECT deliverable_id, artifact_id, requirement, created_at FROM deliverable_artifacts WHERE deliverable_id = ?`)
      .all(input.deliverable_id) as unknown as DeliverableArtifactRow[];
    const coveredRequirements = new Set(memberRows.map((row) => row.requirement));
    const complete = contract.requires.every((requirement) => coveredRequirements.has(requirement));

    const adapter = resolveTargetAdapter(deliverableRow.target_type);
    let valid = complete;
    let detail: string;
    if (adapter) {
      const deliverable = mapDeliverableRow(deliverableRow);
      const members = memberRows.map((row) => ({
        member: mapDeliverableArtifactRow(row),
        artifact: mapArtifactRefRow(
          this.requireRow<ArtifactRefRow>('artifact_refs', row.artifact_id, 'artifact_id', 'ArtifactRef'),
        ),
      }));
      let adapterValid: boolean;
      let adapterDetail: string;
      try {
        const verdict = adapter.validate({ deliverable, contract, members });
        if (
          typeof verdict !== 'object' ||
          verdict === null ||
          typeof verdict.valid !== 'boolean' ||
          typeof verdict.detail !== 'string'
        ) {
          throw new TargetAdapterValidationFailedError({ target_type: deliverableRow.target_type });
        }
        adapterValid = verdict.valid;
        adapterDetail = verdict.detail;
      } catch (err) {
        if (err instanceof TargetAdapterValidationFailedError) throw err;
        throw new TargetAdapterValidationFailedError({ target_type: deliverableRow.target_type });
      }
      valid = complete && adapterValid;
      detail = adapterDetail;
    } else {
      detail = 'no adapter registered';
    }

    const validationState: DeliverableValidationState = valid ? 'valid' : 'invalid';
    const now = provenance.timestamp;
    const nextRevision = deliverableRow.revision + 1;
    this.db
      .prepare(`UPDATE deliverables SET validation_state = ?, validation_detail = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(validationState, detail, now, nextRevision, input.deliverable_id);
    const updated: Deliverable = {
      ...mapDeliverableRow(deliverableRow),
      validation_state: validationState,
      validation_detail: detail,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Deliverable',
      entity_id: input.deliverable_id,
      initiative_id: deliverableRow.initiative_id,
      event_type: 'deliverable_validated',
      payload: { uuid: input.deliverable_id, validation_state: validationState, detail },
      provenance,
    });
    return updated;
  }

  /**
   * `deliverable_deliver` (← AC-1.8): stores `delivery_reference` and appends a new immutable
   * `deliverable_delivery_history` row recording the Deliverable's CURRENT `validation_state`
   * at delivery time — an `invalid` (or `pending`) Deliverable is not vetoed (SPEC-007 FR-7,
   * "The engine must never enforce delivery judgment"). A history row is never updated or
   * deleted; a second delivery appends a second row and leaves the first row's content
   * untouched.
   */
  private mutateDeliverableDeliver(
    input: DeliverableDeliverInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Deliverable {
    const deliverableRow = this.requireDeliverableRow(input.deliverable_id);
    this.requireDeliverableRevision(deliverableRow, expectedRevision);
    const now = provenance.timestamp;
    const nextRevision = deliverableRow.revision + 1;
    this.db
      .prepare(`UPDATE deliverables SET delivery_reference = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.delivery_reference, now, nextRevision, input.deliverable_id);
    this.db
      .prepare(
        `INSERT INTO deliverable_delivery_history (uuid, deliverable_id, delivery_reference, validation_state, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.deliverable_id, input.delivery_reference, deliverableRow.validation_state, now);
    const updated: Deliverable = {
      ...mapDeliverableRow(deliverableRow),
      delivery_reference: input.delivery_reference,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Deliverable',
      entity_id: input.deliverable_id,
      initiative_id: deliverableRow.initiative_id,
      event_type: 'deliverable_delivered',
      payload: {
        uuid: input.deliverable_id,
        delivery_reference: input.delivery_reference,
        validation_state: deliverableRow.validation_state,
      },
      provenance,
    });
    return updated;
  }

  /**
   * `deliverable_approve` (← AC-1.7, maintainer-confirmed shape `{ deliverable: { uuid }, reason
   * }`): the sole operation that may set `validation_state` to `human_approved`. Purely records
   * a human decision — it never recomputes completeness or calls a target adapter, unlike
   * `deliverable_validate` above. `reason` is required and non-empty; the strict Zod input
   * schema (`deliverableApproveInputSchema`) rejects an empty or missing `reason` before this
   * method ever runs, so this method can assume `input.reason` is a non-empty string. The
   * emitted `deliverable_approved` Event payload is exactly `uuid`, `previous_validation_state`,
   * `new_validation_state`, `reason` (Data mapping).
   */
  private mutateDeliverableApprove(
    input: DeliverableApproveInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Deliverable {
    const deliverableRow = this.requireDeliverableRow(input.deliverable.uuid);
    this.requireDeliverableRevision(deliverableRow, expectedRevision);
    const previousValidationState = deliverableRow.validation_state;
    const now = provenance.timestamp;
    const nextRevision = deliverableRow.revision + 1;
    const detail = `human_approved: ${input.reason}`;
    this.db
      .prepare(
        `UPDATE deliverables SET validation_state = 'human_approved', validation_detail = ?, updated_at = ?, revision = ? WHERE uuid = ?`,
      )
      .run(detail, now, nextRevision, input.deliverable.uuid);
    const updated: Deliverable = {
      ...mapDeliverableRow(deliverableRow),
      validation_state: 'human_approved',
      validation_detail: detail,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Deliverable',
      entity_id: input.deliverable.uuid,
      initiative_id: deliverableRow.initiative_id,
      event_type: 'deliverable_approved',
      payload: {
        uuid: input.deliverable.uuid,
        previous_validation_state: previousValidationState,
        new_validation_state: 'human_approved',
        reason: input.reason,
      },
      provenance,
    });
    return updated;
  }

  /**
   * `deliverable_package` (MMA Next gap-closure, §15: listed beside the other Deliverable
   * operations). Assembles the packaging result for a Deliverable from its Delivery Contract's
   * `requires` list and its CURRENT artifact membership only: which entries are covered, by
   * which member Artifacts, and which are still missing. Contract-completeness only — this
   * method never resolves or calls a `TargetAdapter` (unlike `deliverable_validate`) and never
   * invents file content; the committed packager guidance (`loadDeliveryPackager`) supplies the
   * "how to package" prose. Incomplete membership SUCCEEDS and reports the gaps — the engine
   * records and advises, it never blocks packaging on missing coverage. Bumps the Deliverable's
   * revision (like `deliverable_attach_artifact`) even though no `deliverables` column value
   * changes, so a caller can chain a following mutation without an intervening read.
   */
  private mutateDeliverablePackage(
    input: DeliverablePackageInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): DeliverablePackageResult {
    const deliverableRow = this.requireDeliverableRow(input.deliverable_id);
    this.requireDeliverableRevision(deliverableRow, expectedRevision);
    const contract = this.getDeliveryContractOrThrow(deliverableRow.delivery_contract);
    const members = this.listDeliverableMembers({ deliverable_id: input.deliverable_id });

    const coverage: DeliverablePackageCoverage[] = contract.requires.map((requirement) => ({
      requirement,
      members: members
        .filter((member) => member.requirement === requirement)
        .map((member) => ({
          artifact_id: member.artifact_id,
          path_or_uri: this.requireRow<ArtifactRefRow>('artifact_refs', member.artifact_id, 'artifact_id', 'ArtifactRef')
            .path_or_uri,
        })),
    }));
    const missing = coverage.filter((entry) => entry.members.length === 0).map((entry) => entry.requirement);
    const complete = missing.length === 0;
    const packagingGuidance = loadDeliveryPackager(deliverableRow.delivery_contract);

    const now = provenance.timestamp;
    const nextRevision = deliverableRow.revision + 1;
    this.db.prepare(`UPDATE deliverables SET updated_at = ?, revision = ? WHERE uuid = ?`).run(now, nextRevision, input.deliverable_id);
    const updated: Deliverable = { ...mapDeliverableRow(deliverableRow), updatedAt: now, revision: nextRevision };

    this.writeEvent({
      entity_type: 'Deliverable',
      entity_id: input.deliverable_id,
      initiative_id: deliverableRow.initiative_id,
      event_type: 'deliverable_packaged',
      payload: { uuid: input.deliverable_id, delivery_contract: deliverableRow.delivery_contract, complete, missing },
      provenance,
    });

    return { ...updated, coverage, missing, complete, packaging_guidance: packagingGuidance };
  }

  // ---------------------------------------------------------------------
  // Phase A1 — professional record and verification ledger (SPEC-002 FR-3).
  // Task I-3 scope: the seven ordinary mutations below. `evidence_link` and
  // `verification_record` (EvidenceLink integrity, immutable Verification
  // Runs, and stale-evidence propagation) are Task I-4 scope.
  // ---------------------------------------------------------------------

  private mutateRequirementAdd(
    input: RequirementAddInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Requirement {
    this.requireCreateRevision(expectedRevision, 'Requirement');
    this.requireExists('initiatives', input.initiative_id, 'initiative_id', 'Initiative');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateScopedHumanKey(`requirement_human_key:${input.initiative_id}`, 'REQ');
    this.db
      .prepare(
        `INSERT INTO requirements (uuid, initiative_id, human_key, statement, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, input.initiative_id, humanKey, input.statement, now, now);
    const requirement: Requirement = {
      uuid,
      initiative_id: input.initiative_id,
      human_key: humanKey,
      statement: input.statement,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Requirement',
      entity_id: uuid,
      initiative_id: input.initiative_id,
      event_type: 'requirement_added',
      payload: { uuid, initiative_id: input.initiative_id, human_key: humanKey },
      provenance,
    });
    return requirement;
  }

  private mutateAcceptanceCriterionAdd(
    input: AcceptanceCriterionAddInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): AcceptanceCriterion {
    this.requireCreateRevision(expectedRevision, 'AcceptanceCriterion');
    const requirementRow = this.requireRow<RequirementRow>(
      'requirements',
      input.requirement_id,
      'requirement_id',
      'Requirement',
    );
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateScopedHumanKey(`acceptance_criterion_human_key:${input.requirement_id}`, 'AC');
    this.db
      .prepare(
        `INSERT INTO acceptance_criteria (uuid, requirement_id, human_key, statement, check_reference, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, input.requirement_id, humanKey, input.statement, input.check_reference, now, now);
    const criterion: AcceptanceCriterion = {
      uuid,
      requirement_id: input.requirement_id,
      human_key: humanKey,
      statement: input.statement,
      check_reference: input.check_reference,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'AcceptanceCriterion',
      entity_id: uuid,
      initiative_id: requirementRow.initiative_id,
      event_type: 'acceptance_criterion_added',
      payload: { uuid, requirement_id: input.requirement_id, human_key: humanKey },
      provenance,
    });
    return criterion;
  }

  /**
   * `initiative_bootstrap` (SPEC-006 Task I-3, ← AC-1.4, AC-1.5, AC-1.7): the confirmed-draft
   * composite mutation. Runs entirely inside the one explicit transaction {@link execute} already
   * opened — every helper call below is an ordinary `INSERT` + `writeEvent` pair on this same
   * connection, so any thrown error (including {@link maybeForceBootstrapFailure}'s test-only
   * hook) unwinds to `execute()`'s `catch` and rolls back everything this method has written so
   * far, with no special transaction handling needed here.
   *
   * Validation phase (no writes): resolves and compare-and-swaps the Product (create ⇒
   * `expected_revision` must be 0; existing ⇒ `expected_revision` must match its stored
   * revision), pre-generates the Initiative's `uuid` — before validating existing-Workspace
   * ownership, so a rejected cross-Product link can carry the real identifier — validates every
   * `workspaces[]` entry's ownership (an `existing` Workspace under a still-to-be-created Product
   * can never belong to it, so it always rejects) and input-local duplicate create-Workspace
   * slugs, validates input-local duplicate Resource `canonical_locator`s against the same target
   * Workspace, and validates the resolved lifecycle contract is registered.
   *
   * Write phase (dependency order — Data mapping): optional Product, create Workspaces,
   * Resources, Initiative, links, Requirements, Acceptance Criteria. Each step reuses the same
   * per-entity `mutate*` method every other operation uses, so it gets that method's own
   * `INSERT` + exactly one `writeEvent` call for free — this task widens no table and adds no new
   * event type. An `existing` Product or Workspace creates no row and no Event.
   */
  private mutateInitiativeBootstrap(
    input: InitiativeBootstrapInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): InitiativeBootstrapResult {
    // --- Validation phase — nothing below this point writes to the database. ---

    let existingProductRow: ProductRow | undefined;
    if (input.product.existing) {
      existingProductRow = this.requireRow<ProductRow>(
        'products',
        input.product.existing.uuid,
        'product.existing.uuid',
        'Product',
      );
      if (existingProductRow.revision !== expectedRevision) {
        throw new RevisionConflictError({
          entity_type: 'Product',
          entity_id: existingProductRow.uuid,
          expected_revision: expectedRevision,
          actual_revision: existingProductRow.revision,
        });
      }
    } else {
      this.requireCreateRevision(expectedRevision, 'Product');
      this.requireUnique('products', { slug: input.product.create!.slug }, 'Product', 'slug');
    }
    // `undefined` only while `product.create` has not written its row yet (write phase, below) —
    // no `workspaces[].existing` entry can validly resolve against an unwritten Product.
    const resolvedProductId = existingProductRow?.uuid;

    // Pre-generate the Initiative identifier now, before validating existing-Workspace ownership,
    // so `CrossProductWorkspaceLinkError` below always carries the real `initiative_id` this
    // request will create if it is not rejected (Data mapping).
    const initiativeUuid = randomUUID();

    const seenCreateWorkspaceSlugs = new Set<string>();
    for (const workspaceInput of input.workspaces) {
      if (workspaceInput.existing) {
        const workspaceRow = this.requireRow<WorkspaceRow>(
          'workspaces',
          workspaceInput.existing.uuid,
          'workspaces.existing.uuid',
          'Workspace',
        );
        if (!resolvedProductId || workspaceRow.product_id !== resolvedProductId) {
          throw new CrossProductWorkspaceLinkError({ initiative_id: initiativeUuid, workspace_id: workspaceRow.uuid });
        }
      } else {
        const create = workspaceInput.create!;
        if (seenCreateWorkspaceSlugs.has(create.slug)) {
          throw new InvalidRequestError({
            field_errors: { 'workspaces.slug': ['duplicate workspace slug within this request'] },
            message: `invalid_request: duplicate workspace slug ${create.slug} within this request`,
          });
        }
        seenCreateWorkspaceSlugs.add(create.slug);
        if (resolvedProductId) {
          this.requireUnique('workspaces', { product_id: resolvedProductId, slug: create.slug }, 'Workspace', 'slug');
        }
      }
    }

    const seenResourceKeys = new Set<string>();
    for (const resourceInput of input.resources ?? []) {
      const key = `${resourceInput.workspace_key}::${resourceInput.canonical_locator}`;
      if (seenResourceKeys.has(key)) {
        throw new InvalidRequestError({
          field_errors: {
            'resources.canonical_locator': ['duplicate canonical_locator for this workspace within this request'],
          },
          message: `invalid_request: duplicate canonical_locator ${resourceInput.canonical_locator} for workspace_key ${resourceInput.workspace_key} within this request`,
        });
      }
      seenResourceKeys.add(key);
      const targetWorkspace = input.workspaces.find((workspace) => workspace.workspace_key === resourceInput.workspace_key)!;
      if (targetWorkspace.existing) {
        this.requireUnique(
          'resources',
          { workspace_id: targetWorkspace.existing.uuid, canonical_locator: resourceInput.canonical_locator },
          'Resource',
          'canonical_locator',
        );
      }
    }

    const lifecycleContract = input.initiative.lifecycle_contract ?? DEFAULT_LIFECYCLE_CONTRACT_ID;
    if (!this.db.prepare(`SELECT 1 FROM lifecycle_contracts WHERE id = ?`).get(lifecycleContract)) {
      throw new UnknownLifecycleContractError({ lifecycle_contract: lifecycleContract });
    }

    // --- Write phase — dependency order: optional Product, create Workspaces, Resources,
    // Initiative, links, Requirements, Acceptance Criteria. ---

    let product: Product;
    if (existingProductRow) {
      product = mapProductRow(existingProductRow);
    } else {
      product = this.mutateProductCreate(input.product.create!, expectedRevision, provenance);
      this.maybeForceBootstrapFailure('product');
    }

    const workspaceKeyToUuid = new Map<string, string>();
    const workspaceResults: InitiativeBootstrapWorkspaceResult[] = [];
    for (const workspaceInput of input.workspaces) {
      let workspace: Workspace;
      if (workspaceInput.existing) {
        workspace = mapWorkspaceRow(
          this.requireRow<WorkspaceRow>('workspaces', workspaceInput.existing.uuid, 'workspaces.existing.uuid', 'Workspace'),
        );
      } else {
        workspace = this.mutateWorkspaceCreate({ product_id: product.uuid, ...workspaceInput.create! }, 0, provenance);
        this.maybeForceBootstrapFailure('workspace');
      }
      workspaceKeyToUuid.set(workspaceInput.workspace_key, workspace.uuid);
      workspaceResults.push({ ...workspace, workspace_key: workspaceInput.workspace_key, role: workspaceInput.role });
    }

    const resourceResults: InitiativeBootstrapResourceResult[] = [];
    for (const resourceInput of input.resources ?? []) {
      const resource = this.mutateResourceRegister(
        {
          workspace_id: workspaceKeyToUuid.get(resourceInput.workspace_key)!,
          type: resourceInput.type,
          canonical_locator: resourceInput.canonical_locator,
          local_path: resourceInput.local_path,
          description: resourceInput.description,
        },
        0,
        provenance,
      );
      this.maybeForceBootstrapFailure('resource');
      resourceResults.push({ ...resource, workspace_key: resourceInput.workspace_key });
    }

    const initiative = this.mutateInitiativeCreate(
      {
        product_id: product.uuid,
        title: input.initiative.title,
        goal: input.initiative.goal,
        status: input.initiative.status,
        outcome: input.initiative.outcome,
        lifecycle_contract: input.initiative.lifecycle_contract,
      },
      0,
      provenance,
      initiativeUuid,
    );
    this.maybeForceBootstrapFailure('initiative');

    const links: InitiativeWorkspaceLink[] = [];
    for (const workspaceInput of input.workspaces) {
      const link = this.mutateInitiativeLinkWorkspace(
        {
          initiative_id: initiative.uuid,
          workspace_id: workspaceKeyToUuid.get(workspaceInput.workspace_key)!,
          role: workspaceInput.role,
        },
        0,
        provenance,
      );
      this.maybeForceBootstrapFailure('initiative_workspace_link');
      links.push(link);
    }

    const requirementResults: InitiativeBootstrapRequirementResult[] = [];
    for (const requirementInput of input.requirements ?? []) {
      const requirement = this.mutateRequirementAdd(
        { initiative_id: initiative.uuid, statement: requirementInput.statement },
        0,
        provenance,
      );
      this.maybeForceBootstrapFailure('requirement');
      const criteria: AcceptanceCriterion[] = [];
      for (const criterionInput of requirementInput.acceptance_criteria ?? []) {
        const criterion = this.mutateAcceptanceCriterionAdd(
          { requirement_id: requirement.uuid, statement: criterionInput.statement, check_reference: criterionInput.check_reference },
          0,
          provenance,
        );
        this.maybeForceBootstrapFailure('acceptance_criterion');
        criteria.push(criterion);
      }
      requirementResults.push({ ...requirement, acceptance_criteria: criteria });
    }

    return {
      ...initiative,
      product,
      workspaces: workspaceResults,
      resources: resourceResults,
      initiative_workspace_links: links,
      requirements: requirementResults,
    };
  }

  /**
   * Test-only failure injection for `initiative_bootstrap` (SPEC-006 Task I-3): when set, the
   * write phase throws immediately after the named step's creation, proving the whole-transaction
   * rollback guarantee end to end. Non-exported from the public barrel and never invoked by
   * production code — HTTP and MCP callers only ever reach `execute()`, never a direct
   * `InitiativeRecordStore` reference, so this hook is structurally unreachable through either
   * transport. Test/inspection use only.
   */
  setBootstrapFailureStepForTest(step: BootstrapFailureStep | undefined): void {
    this.bootstrapFailureStepForTest = step;
  }

  private maybeForceBootstrapFailure(step: BootstrapFailureStep): void {
    if (this.bootstrapFailureStepForTest === step) {
      throw new Error(`forced bootstrap failure after ${step} creation`);
    }
  }

  private mutateDecisionRecord(
    input: DecisionRecordInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Decision {
    this.requireCreateRevision(expectedRevision, 'Decision');
    this.requireExists('initiatives', input.initiative_id, 'initiative_id', 'Initiative');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateScopedHumanKey(`decision_human_key:${input.initiative_id}`, 'D');
    this.db
      .prepare(
        `INSERT INTO decisions (uuid, initiative_id, human_key, title, decision, rationale, alternatives, status, superseded_by, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
      )
      .run(
        uuid,
        input.initiative_id,
        humanKey,
        input.title,
        input.decision,
        input.rationale,
        JSON.stringify(input.alternatives),
        input.status,
        now,
        now,
      );
    const decision: Decision = {
      uuid,
      initiative_id: input.initiative_id,
      human_key: humanKey,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: input.status,
      superseded_by: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Decision',
      entity_id: uuid,
      initiative_id: input.initiative_id,
      event_type: 'decision_recorded',
      payload: { uuid, initiative_id: input.initiative_id, human_key: humanKey, status: input.status },
      provenance,
    });
    return decision;
  }

  /**
   * One transaction: create the replacement Decision (`status: 'decided'`,
   * `decision_recorded`), then change the old Decision to `'superseded'` with
   * `superseded_by` set to the replacement's `uuid` (`decision_superseded`) —
   * FR-6. Both changes and both Events share this `execute()` call's single
   * open transaction, so a failure at either step rolls back both.
   */
  private mutateDecisionSupersede(
    input: DecisionSupersedeInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Decision {
    const oldRow = this.findDecisionRow(input.uuid, input.initiative_id, input.human_key);
    if (!oldRow) {
      throw new NotFoundError({ entity_type: 'Decision', lookup: input.uuid ?? input.human_key ?? '' });
    }
    if (oldRow.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Decision',
        entity_id: oldRow.uuid,
        expected_revision: expectedRevision,
        actual_revision: oldRow.revision,
      });
    }
    const now = provenance.timestamp;
    const newUuid = randomUUID();
    const humanKey = this.allocateScopedHumanKey(`decision_human_key:${oldRow.initiative_id}`, 'D');
    this.db
      .prepare(
        `INSERT INTO decisions (uuid, initiative_id, human_key, title, decision, rationale, alternatives, status, superseded_by, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 'decided', NULL, ?, ?, 0)`,
      )
      .run(
        newUuid,
        oldRow.initiative_id,
        humanKey,
        input.title,
        input.decision,
        input.rationale,
        JSON.stringify(input.alternatives),
        now,
        now,
      );
    const replacement: Decision = {
      uuid: newUuid,
      initiative_id: oldRow.initiative_id,
      human_key: humanKey,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives,
      status: 'decided',
      superseded_by: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Decision',
      entity_id: newUuid,
      initiative_id: oldRow.initiative_id,
      event_type: 'decision_recorded',
      payload: { uuid: newUuid, initiative_id: oldRow.initiative_id, human_key: humanKey, status: 'decided' },
      provenance,
    });

    const oldNextRevision = oldRow.revision + 1;
    this.db
      .prepare(`UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(newUuid, now, oldNextRevision, oldRow.uuid);
    this.writeEvent({
      entity_type: 'Decision',
      entity_id: oldRow.uuid,
      initiative_id: oldRow.initiative_id,
      event_type: 'decision_superseded',
      payload: { uuid: oldRow.uuid, superseded_by: newUuid },
      provenance,
    });

    return replacement;
  }

  /**
   * Create-or-update by `(initiative_id, locator)` (FR-7). A create requires
   * `expected_revision: 0` and writes `evidence_added`. An update requires the
   * stored revision and may change only `kind`, `content_hash`, and `summary`;
   * it writes `evidence_updated`. Stale-evidence propagation for a changed
   * `content_hash` (FR-11) is Task I-4 scope — not applied here.
   */
  private mutateEvidenceAdd(input: EvidenceAddInput, expectedRevision: number, provenance: ProvenanceInput): Evidence {
    const existingRow = this.db
      .prepare(`SELECT * FROM evidence WHERE initiative_id = ? AND locator = ?`)
      .get(input.initiative_id, input.locator) as EvidenceRow | undefined;
    const now = provenance.timestamp;

    if (!existingRow) {
      this.requireCreateRevision(expectedRevision, 'Evidence');
      this.requireExists('initiatives', input.initiative_id, 'initiative_id', 'Initiative');
      const uuid = randomUUID();
      this.db
        .prepare(
          `INSERT INTO evidence (uuid, initiative_id, kind, locator, content_hash, summary, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(uuid, input.initiative_id, input.kind, input.locator, input.content_hash, input.summary, now, now);
      const evidence: Evidence = {
        uuid,
        initiative_id: input.initiative_id,
        kind: input.kind,
        locator: input.locator,
        content_hash: input.content_hash,
        summary: input.summary,
        createdAt: now,
        updatedAt: now,
        revision: 0,
      };
      this.writeEvent({
        entity_type: 'Evidence',
        entity_id: uuid,
        initiative_id: input.initiative_id,
        event_type: 'evidence_added',
        payload: { uuid, initiative_id: input.initiative_id, locator: input.locator },
        provenance,
      });
      return evidence;
    }

    if (existingRow.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Evidence',
        entity_id: existingRow.uuid,
        expected_revision: expectedRevision,
        actual_revision: existingRow.revision,
      });
    }
    const nextRevision = existingRow.revision + 1;
    this.db
      .prepare(`UPDATE evidence SET kind = ?, content_hash = ?, summary = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.kind, input.content_hash, input.summary, now, nextRevision, existingRow.uuid);
    const evidence: Evidence = {
      uuid: existingRow.uuid,
      initiative_id: existingRow.initiative_id,
      kind: input.kind,
      locator: existingRow.locator,
      content_hash: input.content_hash,
      summary: input.summary,
      createdAt: existingRow.created_at,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Evidence',
      entity_id: existingRow.uuid,
      initiative_id: existingRow.initiative_id,
      event_type: 'evidence_updated',
      payload: { uuid: existingRow.uuid, initiative_id: existingRow.initiative_id, locator: existingRow.locator },
      provenance,
    });
    // Stale-evidence propagation (FR-11): only a CHANGED `content_hash` on an
    // update propagates. An unchanged hash (including two updates that both
    // set the same new hash) must change no VerificationRun and emit no
    // `verification_stale` Event.
    if (input.content_hash !== existingRow.content_hash) {
      this.propagateEvidenceStale(existingRow.uuid, provenance);
    }
    return evidence;
  }

  /**
   * `evidence_link` (FR-8): creates the composite-identity EvidenceLink
   * `(evidence_id, target_type, target_id)` after resolving the target's
   * owning Initiative and confirming it matches the Evidence's Initiative. A
   * duplicate composite identity is an identity-level no-op — it returns the
   * existing record unchanged, writes no Event, and skips every check below
   * (including the revision check), regardless of idempotency key.
   */
  private mutateEvidenceLink(input: EvidenceLinkInput, expectedRevision: number, provenance: ProvenanceInput): EvidenceLink {
    const existingLink = this.db
      .prepare(`SELECT * FROM evidence_links WHERE evidence_id = ? AND target_type = ? AND target_id = ?`)
      .get(input.evidence_id, input.target_type, input.target_id) as EvidenceLinkRow | undefined;
    if (existingLink) {
      return mapEvidenceLinkRow(existingLink);
    }

    const evidenceRow = this.requireRow<EvidenceRow>('evidence', input.evidence_id, 'evidence_id', 'Evidence');
    const targetInitiativeId = this.resolveEvidenceLinkTargetInitiativeId(input.target_type, input.target_id);
    if (targetInitiativeId !== evidenceRow.initiative_id) {
      throw new CrossInitiativeEvidenceLinkError({
        evidence_id: input.evidence_id,
        target_type: input.target_type,
        target_id: input.target_id,
      });
    }
    this.requireCreateRevision(expectedRevision, 'EvidenceLink');

    const now = provenance.timestamp;
    this.db
      .prepare(`INSERT INTO evidence_links (evidence_id, target_type, target_id, created_at, revision) VALUES (?, ?, ?, ?, 0)`)
      .run(input.evidence_id, input.target_type, input.target_id, now);
    const link: EvidenceLink = {
      evidence_id: input.evidence_id,
      target_type: input.target_type,
      target_id: input.target_id,
      createdAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'EvidenceLink',
      entity_id: `${input.evidence_id}:${input.target_type}:${input.target_id}`,
      initiative_id: evidenceRow.initiative_id,
      event_type: 'evidence_linked',
      payload: { evidence_id: input.evidence_id, target_type: input.target_type, target_id: input.target_id },
      provenance,
    });
    return link;
  }

  /** Resolves an EvidenceLink target's owning Initiative, throwing the existing typed `invalid_request` error for a nonexistent target (FR-8). */
  private resolveEvidenceLinkTargetInitiativeId(targetType: EvidenceLinkTargetType, targetId: string): string {
    switch (targetType) {
      case 'requirement': {
        const row = this.requireRow<RequirementRow>('requirements', targetId, 'target_id', 'Requirement');
        return row.initiative_id;
      }
      case 'acceptance_criterion': {
        const row = this.requireRow<AcceptanceCriterionRow>('acceptance_criteria', targetId, 'target_id', 'AcceptanceCriterion');
        const requirementRow = this.requireRow<RequirementRow>(
          'requirements',
          row.requirement_id,
          'requirement_id',
          'Requirement',
        );
        return requirementRow.initiative_id;
      }
      case 'decision': {
        const row = this.requireRow<DecisionRow>('decisions', targetId, 'target_id', 'Decision');
        return row.initiative_id;
      }
      case 'verification_run': {
        const row = this.requireRow<VerificationRunRow>('verification_runs', targetId, 'target_id', 'VerificationRun');
        return row.initiative_id;
      }
      case 'task': {
        const row = this.requireRow<TaskRow>('tasks', targetId, 'target_id', 'Task');
        return row.initiative_id;
      }
    }
  }

  /**
   * Stale-evidence propagation (FR-11): follows EvidenceLinks from the
   * changed Evidence to `target_type: 'verification_run'`, changes only
   * linked runs in `'pass'` or `'fail'` to `'stale'`, and emits one
   * `verification_stale` Event per changed run. Runs inside the caller's
   * `evidence_add` transaction — not a separate one. Changes no other record.
   */
  private propagateEvidenceStale(evidenceId: string, provenance: ProvenanceInput): void {
    const linkRows = this.db
      .prepare(`SELECT target_id FROM evidence_links WHERE evidence_id = ? AND target_type = 'verification_run'`)
      .all(evidenceId) as Array<{ target_id: string }>;
    if (linkRows.length === 0) {
      return;
    }
    const staleEligiblePlaceholders = VERIFICATION_STALE_ELIGIBLE_STATES.map(() => '?').join(', ');
    for (const linkRow of linkRows) {
      const runRow = this.db
        .prepare(`SELECT * FROM verification_runs WHERE uuid = ? AND state IN (${staleEligiblePlaceholders})`)
        .get(linkRow.target_id, ...VERIFICATION_STALE_ELIGIBLE_STATES) as VerificationRunRow | undefined;
      if (!runRow) {
        continue;
      }
      const nextRevision = runRow.revision + 1;
      this.db.prepare(`UPDATE verification_runs SET state = 'stale', revision = ? WHERE uuid = ?`).run(nextRevision, runRow.uuid);
      this.writeEvent({
        entity_type: 'VerificationRun',
        entity_id: runRow.uuid,
        initiative_id: runRow.initiative_id,
        event_type: 'verification_stale',
        payload: { uuid: runRow.uuid, acceptance_criterion_id: runRow.acceptance_criterion_id, evidence_uuid: evidenceId },
        provenance,
      });
    }
  }

  /**
   * `verification_record` (FR-10): creates a new immutable VerificationRun
   * after confirming `acceptance_criterion_id` belongs (via its Requirement)
   * to `initiative_id`. In the same transaction, changes every prior
   * non-terminal run (the pinned `VERIFICATION_NON_TERMINAL_STATES` set —
   * `'pending'`, `'pass'`, `'fail'`, `'blocked'`, `'needs_human_review'`) for
   * the same Acceptance Criterion to `'superseded'`, emitting one
   * `verification_superseded` Event per changed run. The terminal states
   * (`'stale'`, `'not_applicable'`, `'superseded'`) never transition again.
   */
  private mutateVerificationRecord(
    input: VerificationRecordInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): VerificationRun {
    this.requireCreateRevision(expectedRevision, 'VerificationRun');
    const { initiativeId, acceptanceCriterionId } = this.requireVerificationTarget(
      input.initiative_id,
      input.acceptance_criterion_id,
    );
    return this.insertVerificationRun({
      initiativeId,
      acceptanceCriterionId,
      method: input.method,
      state: input.state,
      detail: input.detail,
      eventType: 'verification_recorded',
      provenance,
    });
  }

  /**
   * Shared `acceptance_criterion_id`-belongs-to-`initiative_id` check both `verification_record`
   * and `verification_run` require (FR-10 / MMA Next gap-closure): resolves the Acceptance
   * Criterion through its Requirement and confirms the Requirement's own `initiative_id` matches
   * the caller's. Throws `not_found` for an unknown Acceptance Criterion and
   * `cross_initiative_verification` for a cross-Initiative mismatch, before any write.
   */
  private requireVerificationTarget(
    initiativeId: string,
    acceptanceCriterionId: string,
  ): { initiativeId: string; acceptanceCriterionId: string } {
    this.requireExists('initiatives', initiativeId, 'initiative_id', 'Initiative');
    const criterionRow = this.requireRow<AcceptanceCriterionRow>(
      'acceptance_criteria',
      acceptanceCriterionId,
      'acceptance_criterion_id',
      'AcceptanceCriterion',
    );
    const requirementRow = this.requireRow<RequirementRow>(
      'requirements',
      criterionRow.requirement_id,
      'requirement_id',
      'Requirement',
    );
    if (requirementRow.initiative_id !== initiativeId) {
      throw new CrossInitiativeVerificationError({ initiative_id: initiativeId, acceptance_criterion_id: acceptanceCriterionId });
    }
    return { initiativeId, acceptanceCriterionId };
  }

  /**
   * Shared VerificationRun persistence (FR-10): inserts a new immutable run, writes its Event
   * under `eventType`, then supersedes every prior non-terminal run for the same Acceptance
   * Criterion (the pinned `VERIFICATION_NON_TERMINAL_STATES` set), emitting one
   * `verification_superseded` Event per changed run. Shared by `verification_record` (caller-
   * asserted) and `verification_run` (command-executed) — both persist a VerificationRun
   * identically; only how `state`/`detail` are derived differs.
   */
  private insertVerificationRun(params: {
    initiativeId: string;
    acceptanceCriterionId: string;
    method: VerificationRun['method'];
    state: VerificationRun['state'];
    detail: string;
    eventType: string;
    provenance: ProvenanceInput;
  }): VerificationRun {
    const uuid = randomUUID();
    const now = params.provenance.timestamp;
    this.db
      .prepare(
        `INSERT INTO verification_runs (uuid, initiative_id, acceptance_criterion_id, method, state, detail, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, params.initiativeId, params.acceptanceCriterionId, params.method, params.state, params.detail, now);
    const run: VerificationRun = {
      uuid,
      initiative_id: params.initiativeId,
      acceptance_criterion_id: params.acceptanceCriterionId,
      method: params.method,
      state: params.state,
      detail: params.detail,
      createdAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'VerificationRun',
      entity_id: uuid,
      initiative_id: params.initiativeId,
      event_type: params.eventType,
      payload: {
        uuid,
        initiative_id: params.initiativeId,
        acceptance_criterion_id: params.acceptanceCriterionId,
        method: params.method,
        state: params.state,
      },
      provenance: params.provenance,
    });

    const nonTerminalPlaceholders = VERIFICATION_NON_TERMINAL_STATES.map(() => '?').join(', ');
    const priorRows = this.db
      .prepare(
        `SELECT * FROM verification_runs WHERE acceptance_criterion_id = ? AND uuid != ? AND state IN (${nonTerminalPlaceholders})`,
      )
      .all(params.acceptanceCriterionId, uuid, ...VERIFICATION_NON_TERMINAL_STATES) as unknown as VerificationRunRow[];
    for (const priorRow of priorRows) {
      const nextRevision = priorRow.revision + 1;
      this.db
        .prepare(`UPDATE verification_runs SET state = 'superseded', revision = ? WHERE uuid = ?`)
        .run(nextRevision, priorRow.uuid);
      this.writeEvent({
        entity_type: 'VerificationRun',
        entity_id: priorRow.uuid,
        initiative_id: priorRow.initiative_id,
        event_type: 'verification_superseded',
        payload: { uuid: priorRow.uuid, acceptance_criterion_id: priorRow.acceptance_criterion_id },
        provenance: params.provenance,
      });
    }

    return run;
  }

  /**
   * `verification_run` (MMA Next gap-closure, §15: listed beside `verification_record`).
   * Executes a declared shell command for an Acceptance Criterion whose `method` is `'command'`,
   * captures its exit status and combined output, and persists the resulting VerificationRun —
   * `'pass'` for exit 0, `'fail'` for any other exit code, `'blocked'` when the command could not
   * be run at all (spawn failure or the bounded timeout below). `'agent-review'`/`'human'` are
   * rejected with the typed `verification_method_not_runnable` error before any write; those stay
   * reachable only through `verification_record`.
   *
   * Security-sink review: `input.command` reaches a shell (`node:child_process`, no network
   * access added). This is the SAME trust boundary as every other Initiative Record mutation —
   * the loopback-only, bearer-authenticated HTTP/MCP surface (`request-pipeline.ts`,
   * `loopback-enforcer.ts`) already trusts every caller with free-text writes (Decision prose,
   * Evidence locators, Artifact paths); a caller able to reach this operation could already
   * reach the host's own shell through any other MMA execution route. No additional escaping or
   * allow-listing is layered on top, because the command is meant to run declared local
   * verification exactly as given (e.g. `npm test`), not a sanitizable fixed argument list.
   */
  /**
   * The directory a `verification_run` is confined to: the first local path declared by a Resource
   * under any Workspace linked to this Initiative. Refuses when none exists — an unconfined run
   * would inherit the daemon's cwd and become a sandbox escape (audit M1-1).
   */
  private resolveVerificationRunCwd(initiativeId: string): string {
    for (const { resources } of this.listInitiativeWorkspaceLinksWithDetail({ initiative_id: initiativeId })) {
      for (const resource of resources) {
        if (resource.local_path) return resource.local_path;
      }
    }
    throw new InvalidRequestError({
      field_errors: {
        initiative_id: [
          'verification_run needs a local working directory to run inside: link a Workspace whose '
          + 'Resource declares a local_path, or record the outcome with verification_record instead',
        ],
      },
    });
  }

  /**
   * Executes a declared verification command and classifies the outcome. Called from `execute()`
   * BEFORE the write transaction opens, so a slow command never holds the database lock.
   */
  private runVerificationCommand(input: VerificationRunInput): VerificationCommandOutcome | undefined {
    if (input.method !== 'command') return undefined; // rejected inside the transaction, uniformly
    // Validate the target FIRST, in the same order the mutation does. Hoisting execution out of
    // the transaction must not reorder the errors a caller sees: a cross-Initiative criterion has
    // to be rejected as such, not as a missing working directory. These are reads, so they need no
    // write lock.
    this.requireVerificationTarget(input.initiative_id, input.acceptance_criterion_id);
    const cwd = this.resolveVerificationRunCwd(input.initiative_id);
    const [program, ...args] = parseVerificationCommand(input.command);
    if (!program) {
      throw new InvalidRequestError({ field_errors: { command: ['command must name a program to run'] } });
    }
    const result = spawnSync(program, args, {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout: VERIFICATION_RUN_TIMEOUT_MS,
      maxBuffer: VERIFICATION_RUN_MAX_BUFFER_BYTES,
    });
    if (result.error) {
      return { state: 'blocked', detail: truncateVerificationDetail(`command could not be executed: ${result.error.message}`) };
    }
    if (result.signal) {
      return {
        state: 'blocked',
        detail: truncateVerificationDetail(`command terminated by signal ${result.signal}\n${combineCommandOutput(result.stdout, result.stderr)}`),
      };
    }
    const exitCode = result.status ?? 0;
    return {
      state: exitCode === 0 ? 'pass' : 'fail',
      detail: truncateVerificationDetail(`exit ${exitCode}\n${combineCommandOutput(result.stdout, result.stderr)}`),
    };
  }

  private mutateVerificationRun(
    input: VerificationRunInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
    /** Outcome of the command, already executed OUTSIDE the write transaction (audit M1-3). */
    preRun: VerificationCommandOutcome | undefined,
  ): VerificationRun {
    this.requireCreateRevision(expectedRevision, 'VerificationRun');
    const { initiativeId, acceptanceCriterionId } = this.requireVerificationTarget(
      input.initiative_id,
      input.acceptance_criterion_id,
    );
    if (input.method !== 'command') {
      throw new VerificationMethodNotRunnableError({ method: input.method });
    }

    // CONFINEMENT (audit M1-1). This is the only place the engine itself executes a command, and
    // it is reachable by anything holding the loopback token — including a worker that is itself
    // sandboxed. Run unconfined, it would be a sandbox ESCAPE: a worker confined to its own cwd
    // could ask the daemon to run anything, anywhere the daemon can reach. Two rules close that:
    //
    //   1. The command runs INSIDE the Initiative's own workspace, never the daemon's cwd. If no
    //      linked workspace resource declares a local path, there is no confinement to run within
    //      and the run is refused rather than silently widened.
    //   2. No shell. `shell: true` makes the request body a shell program — metacharacters,
    //      substitution, chaining. The argv form executes exactly one declared program.
    // Already executed before the transaction opened (audit M1-3). `execute()` computes this for
    // every `verification_run`, so its absence means the operation was dispatched from somewhere
    // that skipped that step — a programming error, not a caller error.
    if (!preRun) {
      throw new Error('verification_run reached the store without a pre-executed command outcome');
    }
    const { state, detail } = preRun;

    return this.insertVerificationRun({
      initiativeId,
      acceptanceCriterionId,
      method: input.method,
      state,
      detail,
      eventType: 'verification_run_executed',
      provenance,
    });
  }

  private mutateRiskAdd(input: RiskAddInput, expectedRevision: number, provenance: ProvenanceInput): Risk {
    this.requireCreateRevision(expectedRevision, 'Risk');
    this.requireExists('initiatives', input.initiative_id, 'initiative_id', 'Initiative');
    const uuid = randomUUID();
    const now = provenance.timestamp;
    const humanKey = this.allocateScopedHumanKey(`risk_human_key:${input.initiative_id}`, 'RISK');
    this.db
      .prepare(
        `INSERT INTO risks (uuid, initiative_id, human_key, statement, severity, status, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uuid, input.initiative_id, humanKey, input.statement, input.severity, input.status, now, now);
    const risk: Risk = {
      uuid,
      initiative_id: input.initiative_id,
      human_key: humanKey,
      statement: input.statement,
      severity: input.severity,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.writeEvent({
      entity_type: 'Risk',
      entity_id: uuid,
      initiative_id: input.initiative_id,
      event_type: 'risk_added',
      payload: { uuid, initiative_id: input.initiative_id, human_key: humanKey, severity: input.severity, status: input.status },
      provenance,
    });
    return risk;
  }

  /** The only post-create Risk mutation (FR-9): changes only `status`. No generic Risk update/delete operation exists. */
  private mutateRiskStatus(input: RiskStatusInput, expectedRevision: number, provenance: ProvenanceInput): Risk {
    const row = this.findRiskRow(input.uuid, input.initiative_id, input.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Risk', lookup: input.uuid ?? input.human_key ?? '' });
    }
    if (row.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Risk',
        entity_id: row.uuid,
        expected_revision: expectedRevision,
        actual_revision: row.revision,
      });
    }
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db.prepare(`UPDATE risks SET status = ?, updated_at = ?, revision = ? WHERE uuid = ?`).run(
      input.status,
      now,
      nextRevision,
      row.uuid,
    );
    const risk: Risk = {
      uuid: row.uuid,
      initiative_id: row.initiative_id,
      human_key: row.human_key,
      statement: row.statement,
      severity: row.severity,
      status: input.status,
      createdAt: row.created_at,
      updatedAt: now,
      revision: nextRevision,
    };
    this.writeEvent({
      entity_type: 'Risk',
      entity_id: row.uuid,
      initiative_id: row.initiative_id,
      event_type: 'risk_status_changed',
      payload: { uuid: row.uuid, status: input.status },
      provenance,
    });
    return risk;
  }

  // ---------------------------------------------------------------------
  // SPEC-004 Lifecycle Engine — phase/focus mutations and the contract
  // reference mutation (Task I-2, FR-2 through FR-7). Every mutation below
  // runs under the SAME Initiative aggregate revision, idempotency,
  // provenance, Event, and rollback discipline as every other operation in
  // `execute()`: a phase transition or focus/contract change increments the
  // Initiative's own `revision` exactly once and appends exactly one
  // Initiative Event, whether or not `initiatives.focus_phase` or
  // `initiatives.lifecycle_contract` itself changed. An illegal source state
  // throws BEFORE any write — no phase row, Initiative revision, or Event
  // survives a rejected transition. A gate's colour is never consulted by a
  // transition legality check: advisory gates never veto a caller-authorized
  // mutation (FR-8).
  // ---------------------------------------------------------------------

  /** Legal source `PhaseRecordState`s for each phase mutation (SPEC-004 "Data model" transition table). */
  private static readonly PHASE_ENTER_LEGAL_SOURCES: readonly PhaseRecordState[] = [
    'not_started',
    'reopened',
    'skipped',
    'satisfied',
  ];
  private static readonly PHASE_SATISFY_LEGAL_SOURCES: readonly PhaseRecordState[] = ['active', 'reopened'];
  private static readonly PHASE_REOPEN_LEGAL_SOURCES: readonly PhaseRecordState[] = ['satisfied', 'skipped'];
  private static readonly PHASE_SKIP_LEGAL_SOURCES: readonly PhaseRecordState[] = ['not_started', 'active'];

  /**
   * Resolves the Initiative through the lookup selector and enforces its `expected_revision`
   * (preserving `not_found` and `revision_conflict` exactly like every other operation),
   * exactly like the SPEC-003 task operations' own selector resolution. Every lifecycle
   * mutation shares this one entry point.
   */
  private requireInitiativeForLifecycle(
    lookup: { uuid?: string; human_key?: string },
    expectedRevision: number,
  ): InitiativeRow {
    const row = this.findInitiativeRow(lookup.uuid, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    if (row.revision !== expectedRevision) {
      throw new RevisionConflictError({
        entity_type: 'Initiative',
        entity_id: row.uuid,
        expected_revision: expectedRevision,
        actual_revision: row.revision,
      });
    }
    return row;
  }

  /**
   * The shared six-phase overlay helper (SPEC-004 "Data model"): the single source of
   * synthesized `not_started` defaults for both mutations (here) and later reads (Task I-4).
   * It starts with every canonical phase, then overlays persisted phase records for this
   * Initiative. Callers select the phase they need from the complete overlay.
   */
  private getPhaseStates(initiativeId: string): Record<Phase, PhaseRecordState> {
    const states = Object.fromEntries(LIFECYCLE_PHASES.map((phase) => [phase, 'not_started'])) as Record<
      Phase,
      PhaseRecordState
    >;
    const rows = this.db
      .prepare(`SELECT phase, state FROM phase_records WHERE initiative_id = ?`)
      .all(initiativeId) as Array<{ phase: string; state: string }>;
    for (const row of rows) {
      if (!LIFECYCLE_PHASES.includes(row.phase as Phase)) {
        throw new InvalidRequestError({
          field_errors: { phase_records: [`contains unknown phase '${row.phase}' for Initiative ${initiativeId}`] },
          message: `invalid_request: corrupted phase_records row contains unknown phase '${row.phase}'`,
        });
      }
      if (!['not_started', 'active', 'satisfied', 'reopened', 'skipped'].includes(row.state)) {
        throw new InvalidRequestError({
          field_errors: { phase_records: [`contains unknown state '${row.state}' for phase '${row.phase}'`] },
          message: `invalid_request: corrupted phase_records row contains unknown state '${row.state}'`,
        });
      }
      states[row.phase as Phase] = row.state as PhaseRecordState;
    }
    return states;
  }

  /** Writes (inserting or updating) exactly one `phase_records` row for `(initiative_id, phase)`. */
  private upsertPhaseRecord(initiativeId: string, phase: Phase, state: PhaseRecordState): void {
    this.db
      .prepare(
        `INSERT INTO phase_records (initiative_id, phase, state) VALUES (?, ?, ?)
         ON CONFLICT(initiative_id, phase) DO UPDATE SET state = excluded.state`,
      )
      .run(initiativeId, phase, state);
  }

  /** Increments the Initiative aggregate's own `revision` exactly once and stamps `updated_at`. Returns the new revision. */
  private bumpInitiativeRevision(row: InitiativeRow, now: string): number {
    const nextRevision = row.revision + 1;
    this.db.prepare(`UPDATE initiatives SET updated_at = ?, revision = ? WHERE uuid = ?`).run(now, nextRevision, row.uuid);
    return nextRevision;
  }

  /** Loads and parses a registered Lifecycle Contract's `definition_json`. Throws `unknown_lifecycle_contract` for an unregistered id. */
  private getLifecycleContractOrThrow(id: string): LifecycleContract {
    const row = this.db.prepare(`SELECT definition_json FROM lifecycle_contracts WHERE id = ?`).get(id) as
      | { definition_json?: string }
      | undefined;
    if (!row || row.definition_json === undefined) {
      throw new UnknownLifecycleContractError({ lifecycle_contract: id });
    }
    try {
      return JSON.parse(row.definition_json) as LifecycleContract;
    } catch {
      throw new InvalidRequestError({
        field_errors: { lifecycle_contract: [`registered contract '${id}' has malformed stored definition JSON`] },
        message: `invalid_request: lifecycle contract '${id}' has malformed stored definition JSON`,
      });
    }
  }

  /**
   * Validates `initiative_phase_satisfy`'s `asserted` keys against the SELECTED contract's
   * phase Establishments (SPEC-004 "Data model"): every key must be one of that phase's
   * required Establishment keys; a `null` contract accepts only an empty list. Duplicate
   * keys are already rejected by Task I-1's Zod schema before this runs.
   */
  private validateAssertedKeys(asserted: readonly string[], contract: LifecycleContract | null, phase: Phase): void {
    if (!contract) {
      if (asserted.length > 0) {
        throw new InvalidRequestError({
          field_errors: { asserted: ["must be empty: this Initiative's lifecycle_contract is null"] },
          message: 'invalid_request: asserted keys require an Initiative with a non-null lifecycle_contract',
        });
      }
      return;
    }
    const validKeys = new Set((contract.phases[phase]?.required ?? []).map((establishment) => establishment.key));
    for (const key of asserted) {
      if (!validKeys.has(key)) {
        throw new InvalidRequestError({
          field_errors: { asserted: [`unknown establishment key '${key}' for phase '${phase}'`] },
          message: `invalid_request: asserted key ${key} is not a required Establishment of phase ${phase} in contract ${contract.id}`,
        });
      }
    }
  }

  /**
   * Evaluates the live advisory gate for `phase` (Task I-3's pure evaluator, called with
   * already-read live record data — this module remains the only database owner). When
   * `prospectiveSatisfyAsserted` is supplied, a not-yet-persisted `phase_satisfied` Event at
   * the current mutation's own future `event_sequence` is appended first, so the current
   * request's own (already-validated) assertions count toward its own snapshot (SPEC-004
   * "Data model" — "computed AFTER counting the current request's asserted keys as valid").
   */
  /**
   * The Initiative-wide inputs every gate evaluation needs. Read once and shared across a whole
   * six-phase sweep (audit M1-11): the gate for `discover` and the gate for `deliver` are computed
   * from exactly the same Requirements, Acceptance Criteria, Decisions, Events and Deliverables —
   * only the contract's phase entry differs — so reading them per phase re-read the entire record
   * six times for one `initiative_resume`.
   */
  private readGateInputs(initiativeId: string): GateInputs {
    return {
      requirements: this.listRequirements({ initiative_id: initiativeId }),
      acceptanceCriteria: this.listAcceptanceCriteria({ initiative_id: initiativeId }),
      decisions: this.listDecisions({ initiative_id: initiativeId }),
      events: this.listEvents({ initiative_id: initiativeId }),
      deliverableValidationStates: this.listDeliverables({ initiative_id: initiativeId }).map(
        (deliverable) => deliverable.validation_state,
      ),
    };
  }

  private evaluateGate(
    initiativeId: string,
    phase: Phase,
    contract: LifecycleContract | null,
    prospectiveSatisfyAsserted?: readonly string[],
    /** Shared snapshot when sweeping several phases; read fresh when absent. */
    sharedInputs?: GateInputs,
  ): GateStatus {
    const { requirements, acceptanceCriteria, decisions, events, deliverableValidationStates } =
      sharedInputs ?? this.readGateInputs(initiativeId);
    const effectiveEvents =
      prospectiveSatisfyAsserted !== undefined
        ? [...events, this.buildProspectiveSatisfiedEvent(initiativeId, phase, prospectiveSatisfyAsserted)]
        : events;
    return evaluateLifecycleGate({
      contract,
      phase,
      requirements,
      acceptanceCriteria,
      decisions,
      events: effectiveEvents,
      deliverableValidationStates,
    });
  }

  /** A not-yet-persisted `phase_satisfied` Event standing in for the current mutation's own future Event, for snapshot purposes only. Never written to `events`. */
  private buildProspectiveSatisfiedEvent(initiativeId: string, phase: Phase, asserted: readonly string[]): Event {
    return {
      event_sequence: this.nextEventSequence(),
      entity_type: 'Initiative',
      entity_id: initiativeId,
      initiative_id: initiativeId,
      event_type: 'phase_satisfied',
      payload: { phase, previous_state: 'active', new_state: 'satisfied', asserted: [...asserted], gate_snapshot: null },
      actor_type: 'system',
      actor_id: 'lifecycle-gate-evaluator',
      interface: 'internal',
      initiated_by: 'lifecycle-gate-evaluator',
      authorized_by: 'lifecycle-gate-evaluator',
      timestamp: '1970-01-01T00:00:00.000Z',
      source: 'internal',
    };
  }

  /**
   * `initiative_phase_enter` (SPEC-004 "Data model" transition table): `not_started |
   * reopened | skipped | satisfied -> active`. No `gate_snapshot` — that field is frozen to
   * `phase_satisfied` and `focus_changed` only (`INITIATIVE_EVENT_PAYLOAD_KEYS`).
   */
  private mutateInitiativePhaseEnter(
    input: InitiativePhaseEnterInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): PhaseRecord {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    const previousState = this.getPhaseStates(row.uuid)[input.phase];
    if (!InitiativeRecordStore.PHASE_ENTER_LEGAL_SOURCES.includes(previousState)) {
      throw new InvalidPhaseTransitionError({
        initiative_id: row.uuid,
        phase: input.phase,
        source_state: previousState,
        target_state: 'active',
      });
    }
    this.upsertPhaseRecord(row.uuid, input.phase, 'active');
    const revision = this.bumpInitiativeRevision(row, provenance.timestamp);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'phase_entered',
      payload: { phase: input.phase, previous_state: previousState, new_state: 'active' },
      provenance,
    });
    return { initiative_id: row.uuid, phase: input.phase, state: 'active', revision };
  }

  /**
   * `initiative_phase_satisfy` (SPEC-004 "Data model" transition table): `active | reopened
   * -> satisfied`. Validates `asserted` (optional; normalizes to `[]`) against the selected
   * contract's phase Establishments BEFORE the snapshot calculation and the Event write, then
   * computes `gate_snapshot` counting this request's own assertions as valid. `asserted` and
   * `gate_snapshot` are always recorded on the Event, whichever colour the gate reads.
   */
  private mutateInitiativePhaseSatisfy(
    input: InitiativePhaseSatisfyInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): PhaseRecord {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    const previousState = this.getPhaseStates(row.uuid)[input.phase];
    if (!InitiativeRecordStore.PHASE_SATISFY_LEGAL_SOURCES.includes(previousState)) {
      throw new InvalidPhaseTransitionError({
        initiative_id: row.uuid,
        phase: input.phase,
        source_state: previousState,
        target_state: 'satisfied',
      });
    }
    const asserted = input.asserted ?? [];
    const contract = row.lifecycle_contract ? this.getLifecycleContractOrThrow(row.lifecycle_contract) : null;
    this.validateAssertedKeys(asserted, contract, input.phase);
    const gateSnapshot = this.evaluateGate(row.uuid, input.phase, contract, asserted);
    this.upsertPhaseRecord(row.uuid, input.phase, 'satisfied');
    const revision = this.bumpInitiativeRevision(row, provenance.timestamp);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'phase_satisfied',
      payload: {
        phase: input.phase,
        previous_state: previousState,
        new_state: 'satisfied',
        asserted,
        gate_snapshot: gateSnapshot,
      },
      provenance,
    });
    return { initiative_id: row.uuid, phase: input.phase, state: 'satisfied', revision };
  }

  /**
   * `initiative_phase_reopen` (SPEC-004 "Data model" transition table): `satisfied | skipped
   * -> reopened`. `reason` is already validated non-empty by Task I-1's Zod schema before
   * this method runs.
   */
  private mutateInitiativePhaseReopen(
    input: InitiativePhaseReopenInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): PhaseRecord {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    const previousState = this.getPhaseStates(row.uuid)[input.phase];
    if (!InitiativeRecordStore.PHASE_REOPEN_LEGAL_SOURCES.includes(previousState)) {
      throw new InvalidPhaseTransitionError({
        initiative_id: row.uuid,
        phase: input.phase,
        source_state: previousState,
        target_state: 'reopened',
      });
    }
    this.upsertPhaseRecord(row.uuid, input.phase, 'reopened');
    const revision = this.bumpInitiativeRevision(row, provenance.timestamp);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'phase_reopened',
      payload: { phase: input.phase, previous_state: previousState, new_state: 'reopened', reason: input.reason },
      provenance,
    });
    return { initiative_id: row.uuid, phase: input.phase, state: 'reopened', revision };
  }

  /**
   * `initiative_phase_skip` (SPEC-004 "Data model" transition table): `not_started | active
   * -> skipped`. `reason` is already validated non-empty by Task I-1's Zod schema before this
   * method runs.
   */
  private mutateInitiativePhaseSkip(
    input: InitiativePhaseSkipInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): PhaseRecord {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    const previousState = this.getPhaseStates(row.uuid)[input.phase];
    if (!InitiativeRecordStore.PHASE_SKIP_LEGAL_SOURCES.includes(previousState)) {
      throw new InvalidPhaseTransitionError({
        initiative_id: row.uuid,
        phase: input.phase,
        source_state: previousState,
        target_state: 'skipped',
      });
    }
    this.upsertPhaseRecord(row.uuid, input.phase, 'skipped');
    const revision = this.bumpInitiativeRevision(row, provenance.timestamp);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'phase_skipped',
      payload: { phase: input.phase, previous_state: previousState, new_state: 'skipped', reason: input.reason },
      provenance,
    });
    return { initiative_id: row.uuid, phase: input.phase, state: 'skipped', revision };
  }

  /**
   * `initiative_focus_set` (SPEC-004 "Data model"): any current Phase Record state is
   * always a legal source — focus is caller-declared attention, not a workflow gate. Records
   * the live gate for the target phase AT MUTATION TIME (no prospective Event — this
   * mutation writes no Phase Record).
   */
  private mutateInitiativeFocusSet(
    input: InitiativeFocusSetInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Initiative {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    const previousFocusPhase = row.focus_phase;
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE initiatives SET focus_phase = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.phase, now, nextRevision, row.uuid);
    const contract = row.lifecycle_contract ? this.getLifecycleContractOrThrow(row.lifecycle_contract) : null;
    const gateSnapshot = this.evaluateGate(row.uuid, input.phase, contract);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'focus_changed',
      payload: {
        phase: input.phase,
        previous_focus_phase: previousFocusPhase,
        new_focus_phase: input.phase,
        gate_snapshot: gateSnapshot,
      },
      provenance,
    });
    const updatedRow = this.findInitiativeRow(row.uuid, undefined)!;
    return mapInitiativeRow(updatedRow);
  }

  /**
   * `initiative_set_lifecycle_contract` (SPEC-004 FR-7): a non-null `lifecycle_contract` must
   * already be registered (`unknown_lifecycle_contract` otherwise); `null` clears the
   * reference. Always legal regardless of any Phase Record state.
   */
  private mutateInitiativeSetLifecycleContract(
    input: InitiativeSetLifecycleContractInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Initiative {
    const row = this.requireInitiativeForLifecycle(input.initiative, expectedRevision);
    if (input.lifecycle_contract !== null) {
      const exists = this.db.prepare(`SELECT 1 FROM lifecycle_contracts WHERE id = ?`).get(input.lifecycle_contract);
      if (!exists) {
        throw new UnknownLifecycleContractError({ lifecycle_contract: input.lifecycle_contract });
      }
    }
    const previousContract = row.lifecycle_contract;
    const now = provenance.timestamp;
    const nextRevision = row.revision + 1;
    this.db
      .prepare(`UPDATE initiatives SET lifecycle_contract = ?, updated_at = ?, revision = ? WHERE uuid = ?`)
      .run(input.lifecycle_contract, now, nextRevision, row.uuid);
    this.writeEvent({
      entity_type: 'Initiative',
      entity_id: row.uuid,
      initiative_id: row.uuid,
      event_type: 'lifecycle_contract_set',
      payload: { previous_lifecycle_contract: previousContract, new_lifecycle_contract: input.lifecycle_contract },
      provenance,
    });
    const updatedRow = this.findInitiativeRow(row.uuid, undefined)!;
    return mapInitiativeRow(updatedRow);
  }

  /** Bounded window for `LifecycleResumeBlock.recent_lifecycle_events` (Task I-4, SPEC-004 "Data model" — no caller-selected limit exists for this read; the store fixes an internal policy instead). */
  private static readonly LIFECYCLE_EVENTS_WINDOW = 20;

  /** The exact lifecycle Event types surfaced in `recent_lifecycle_events` — every other Initiative Event type (e.g. `task_completed`, `requirement_added`) is excluded, matching `INITIATIVE_EVENT_TYPES`'s SPEC-004 entries. */
  private static readonly LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
    'phase_entered',
    'phase_satisfied',
    'phase_reopened',
    'phase_skipped',
    'focus_changed',
    'lifecycle_contract_set',
  ]);

  /**
   * Assembles the additive `LifecycleResumeBlock` `initiative_resume` and the dedicated
   * `initiative_gate_status` read both return (Task I-4, FR-9, FR-13). Resolves the
   * Initiative through the same lookup selector as every other read (throws `not_found` for
   * an unknown lookup, exactly like {@link getInitiative}); overlays the shared six-phase
   * state via {@link getPhaseStates} (the single source of synthesized `not_started`
   * defaults, reused unchanged from Task I-2); evaluates one fresh, unpersisted gate per
   * phase with {@link evaluateGate} (no prospective assertion — this is a read, never a
   * mutation); and returns the newest Initiative-scoped lifecycle Events bounded by the
   * internal fixed window. Performs no write of any kind — every value comes from an
   * already-implemented Task I-2/I-3 read helper.
   */
  getLifecycleResumeBlock(lookup: { uuid?: string; human_key?: string }): LifecycleResumeBlock {
    const row = this.findInitiativeRow(lookup.uuid, lookup.human_key);
    if (!row) {
      throw new NotFoundError({ entity_type: 'Initiative', lookup: lookup.uuid ?? lookup.human_key ?? '' });
    }
    const phaseStates = this.getPhaseStates(row.uuid);
    const contract = row.lifecycle_contract ? this.getLifecycleContractOrThrow(row.lifecycle_contract) : null;
    // One read of the Initiative-wide inputs for the whole six-phase sweep, and the Event log is
    // reused for the lifecycle-event tail below rather than fetched a second time (audit M1-11).
    const gateInputs = this.readGateInputs(row.uuid);
    const phases = LIFECYCLE_PHASES.map((phase) => ({
      phase,
      state: phaseStates[phase],
      gate: this.evaluateGate(row.uuid, phase, contract, undefined, gateInputs),
    }));
    const lifecycleEvents = gateInputs.events.filter((event) =>
      InitiativeRecordStore.LIFECYCLE_EVENT_TYPES.has(event.event_type),
    );
    const recentLifecycleEvents = [...lifecycleEvents]
      .reverse()
      .slice(0, InitiativeRecordStore.LIFECYCLE_EVENTS_WINDOW);
    return {
      focus_phase: row.focus_phase,
      contract: row.lifecycle_contract,
      phases,
      recent_lifecycle_events: recentLifecycleEvents,
    };
  }

  /** Raises a `counters` row to at least `minValue` (creating it at `minValue` if absent), never lowering an existing higher value. Used by `initiative_import` so a subsequent human-key allocation on an imported Initiative/Requirement/etc. cannot collide with an imported number. */
  private raiseCounterFloor(counterName: string, minValue: number): void {
    this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`,
      )
      .run(counterName, minValue);
  }

  /** Extracts the trailing `<n>` from a `<prefix>-<n>` human key (e.g. `MMA-INIT-005` -> `5`, `REQ-12` -> `12`). `0` for a malformed key — never lowers a counter below its current value. */
  private parseHumanKeyNumber(humanKey: string): number {
    const match = /-(\d+)$/.exec(humanKey);
    return match ? Number(match[1]) : 0;
  }

  /**
   * Ensures a wire-valid import snapshot is also a portable snapshot of exactly ONE Initiative.
   * Zod can validate UUID syntax and each individual row shape, but cannot express the ownership
   * graph between sibling arrays. Without this check a row such as an Artifact carrying another
   * Initiative's UUID could be inserted successfully, then disappear from the next export (which
   * correctly scopes its query to the imported Initiative). Reject before the first write so this
   * remains a validation-shaped, all-or-nothing failure rather than latent data loss.
   */
  private validateInitiativeImportSnapshot(snapshot: InitiativeExportSnapshotInput): void {
    const initiativeId = snapshot.initiative.uuid;
    const invalid = (field: string, message: string): never => {
      throw new InvalidRequestError({
        field_errors: { [field]: [message] },
        message: `invalid_request: invalid Initiative export snapshot: ${message}`,
      });
    };
    const requireInitiativeOwnership = <T extends { initiative_id: string }>(entries: T[], field: string): void => {
      for (const [index, entry] of entries.entries()) {
        if (entry.initiative_id !== initiativeId) {
          invalid(`${field}.${index}.initiative_id`, `must equal snapshot.initiative.uuid (${initiativeId})`);
        }
      }
    };

    if (snapshot.product.uuid !== snapshot.initiative.product_id) {
      invalid('product.uuid', `must equal snapshot.initiative.product_id (${snapshot.initiative.product_id})`);
    }

    for (const [index, entry] of snapshot.workspaces.entries()) {
      if (entry.link.initiative_id !== initiativeId) {
        invalid(`workspaces.${index}.link.initiative_id`, `must equal snapshot.initiative.uuid (${initiativeId})`);
      }
      if (entry.workspace.product_id !== snapshot.product.uuid) {
        invalid(`workspaces.${index}.workspace.product_id`, `must equal snapshot.product.uuid (${snapshot.product.uuid})`);
      }
      for (const [resourceIndex, resource] of entry.resources.entries()) {
        if (resource.workspace_id !== entry.workspace.uuid) {
          invalid(
            `workspaces.${index}.resources.${resourceIndex}.workspace_id`,
            `must equal its containing Workspace uuid (${entry.workspace.uuid})`,
          );
        }
      }
    }

    requireInitiativeOwnership(snapshot.tasks, 'tasks');
    requireInitiativeOwnership(snapshot.artifacts, 'artifacts');
    requireInitiativeOwnership(snapshot.requirements, 'requirements');
    requireInitiativeOwnership(snapshot.decisions, 'decisions');
    requireInitiativeOwnership(snapshot.evidence, 'evidence');
    requireInitiativeOwnership(snapshot.risks, 'risks');
    requireInitiativeOwnership(snapshot.verification_runs, 'verification_runs');

    const requirementIds = new Set(snapshot.requirements.map((requirement) => requirement.uuid));
    for (const [index, criterion] of snapshot.acceptance_criteria.entries()) {
      if (!requirementIds.has(criterion.requirement_id)) {
        invalid(
          `acceptance_criteria.${index}.requirement_id`,
          `references Requirement ${criterion.requirement_id}, which is absent from snapshot.requirements`,
        );
      }
    }
    const criterionIds = new Set(snapshot.acceptance_criteria.map((criterion) => criterion.uuid));
    for (const [index, run] of snapshot.verification_runs.entries()) {
      if (!criterionIds.has(run.acceptance_criterion_id)) {
        invalid(
          `verification_runs.${index}.acceptance_criterion_id`,
          `references Acceptance Criterion ${run.acceptance_criterion_id}, which is absent from snapshot.acceptance_criteria`,
        );
      }
    }

    const artifactIds = new Set(snapshot.artifacts.map((artifact) => artifact.uuid));
    for (const [index, bundle] of snapshot.deliverables.entries()) {
      if (bundle.deliverable.initiative_id !== initiativeId) {
        invalid(`deliverables.${index}.deliverable.initiative_id`, `must equal snapshot.initiative.uuid (${initiativeId})`);
      }
      for (const [memberIndex, member] of bundle.members.entries()) {
        if (member.deliverable_id !== bundle.deliverable.uuid) {
          invalid(
            `deliverables.${index}.members.${memberIndex}.deliverable_id`,
            `must equal its containing Deliverable uuid (${bundle.deliverable.uuid})`,
          );
        }
        if (!artifactIds.has(member.artifact_id)) {
          invalid(
            `deliverables.${index}.members.${memberIndex}.artifact_id`,
            `references Artifact ${member.artifact_id}, which is absent from snapshot.artifacts`,
          );
        }
      }
      for (const [historyIndex, history] of bundle.history.entries()) {
        if (history.deliverable_id !== bundle.deliverable.uuid) {
          invalid(
            `deliverables.${index}.history.${historyIndex}.deliverable_id`,
            `must equal its containing Deliverable uuid (${bundle.deliverable.uuid})`,
          );
        }
      }
    }

    for (const [index, event] of snapshot.events.entries()) {
      if (event.initiative_id !== initiativeId) {
        invalid(`events.${index}.initiative_id`, `must equal snapshot.initiative.uuid (${initiativeId})`);
      }
    }
  }

  /**
   * `initiative_import` (MMA Next gap-closure, §21 success criterion 12: "an Initiative can be
   * exported to a portable snapshot and re-imported"). Reconstructs one Initiative and every
   * record `initiative_export` names into THIS store, in the SAME one-transaction envelope
   * `execute()` already opens (BEGIN IMMEDIATE / COMMIT / ROLLBACK) — no nested transaction, no
   * partial write on any failure below.
   *
   * Rejects a snapshot whose `schema_version` this build does not understand, and rejects an
   * Initiative that already exists (by `uuid` OR `human_key`) with the conflict-shaped
   * `initiative_already_exists` error — import never silently merges. Every record is inserted
   * with its EXACT original identity (`uuid`, timestamps, `revision`) rather than replayed
   * through the ordinary create mutations, so a round trip (export -> fresh store -> import ->
   * export) reproduces equivalent content. Product/Workspace/Resource rows use `INSERT OR
   * IGNORE`, because those are NOT Initiative-owned — a caller may import a second Initiative
   * that shares an already-imported Product or Workspace. Every human-key counter the imported
   * data could collide with is raised to at least the imported number, so a later
   * `requirement_add`/`decision_record`/etc. against the imported Initiative cannot mint a
   * duplicate human key.
   */
  private mutateInitiativeImport(
    input: InitiativeImportInput,
    expectedRevision: number,
    provenance: ProvenanceInput,
  ): Initiative {
    this.requireCreateRevision(expectedRevision, 'Initiative');
    const snapshot: InitiativeExportSnapshotInput = input.snapshot;
    if (snapshot.schema_version !== INITIATIVE_EXPORT_SCHEMA_VERSION) {
      throw new InvalidRequestError({
        field_errors: {
          schema_version: [
            `unsupported snapshot schema_version ${snapshot.schema_version}; this build understands schema_version ${INITIATIVE_EXPORT_SCHEMA_VERSION}`,
          ],
        },
        message: `invalid_request: unsupported Initiative export schema_version ${snapshot.schema_version}`,
      });
    }
    this.validateInitiativeImportSnapshot(snapshot);
    const existing = this.db
      .prepare(`SELECT 1 FROM initiatives WHERE uuid = ? OR human_key = ? LIMIT 1`)
      .get(snapshot.initiative.uuid, snapshot.initiative.human_key) as Record<string, unknown> | undefined;
    if (existing) {
      throw new InitiativeAlreadyExistsError({ uuid: snapshot.initiative.uuid, human_key: snapshot.initiative.human_key });
    }

    const product = snapshot.product;
    this.db
      .prepare(`INSERT OR IGNORE INTO products (uuid, name, slug, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(product.uuid, product.name, product.slug, product.createdAt, product.updatedAt, product.revision);

    for (const entry of snapshot.workspaces) {
      const ws = entry.workspace;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO workspaces (uuid, product_id, name, slug, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ws.uuid, ws.product_id, ws.name, ws.slug, ws.description, ws.createdAt, ws.updatedAt, ws.revision);
      for (const resource of entry.resources) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO resources (uuid, workspace_id, type, canonical_locator, local_path, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resource.uuid,
            resource.workspace_id,
            resource.type,
            resource.canonical_locator,
            resource.local_path,
            resource.description,
            resource.createdAt,
            resource.updatedAt,
            resource.revision,
          );
      }
    }

    const initiative = snapshot.initiative;
    this.db
      .prepare(
        `INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision, focus_phase, lifecycle_contract) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        initiative.uuid,
        initiative.human_key,
        initiative.product_id,
        initiative.title,
        initiative.goal,
        initiative.status,
        initiative.outcome,
        initiative.createdAt,
        initiative.updatedAt,
        initiative.revision,
        initiative.focus_phase,
        initiative.lifecycle_contract,
      );
    this.raiseCounterFloor('initiative_human_key', this.parseHumanKeyNumber(initiative.human_key));

    for (const entry of snapshot.workspaces) {
      this.db
        .prepare(`INSERT INTO initiative_workspace_links (initiative_id, workspace_id, role, created_at, revision) VALUES (?, ?, ?, ?, ?)`)
        .run(entry.link.initiative_id, entry.link.workspace_id, entry.link.role, entry.link.createdAt, entry.link.revision);
    }

    for (const task of snapshot.tasks) {
      this.db
        .prepare(
          `INSERT INTO tasks (uuid, initiative_id, title, goal, status, outcome, workspace_ids, resource_ids, execution_refs, created_at, updated_at, revision, claimed_by, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.uuid,
          task.initiative_id,
          task.title,
          task.goal,
          task.status,
          task.outcome,
          JSON.stringify(task.workspace_ids),
          JSON.stringify(task.resource_ids),
          JSON.stringify(task.executionRefs),
          task.createdAt,
          task.updatedAt,
          task.revision,
          task.claimed_by,
          task.method,
        );
    }

    for (const artifact of snapshot.artifacts) {
      this.db
        .prepare(
          `INSERT INTO artifact_refs (uuid, initiative_id, storage_mode, path_or_uri, content_hash, media_type, version, produced_by_task, description, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.uuid,
          artifact.initiative_id,
          artifact.storage_mode,
          artifact.path_or_uri,
          artifact.content_hash,
          artifact.media_type,
          artifact.version,
          artifact.produced_by_task,
          artifact.description,
          artifact.createdAt,
          artifact.updatedAt,
          artifact.revision,
        );
    }

    for (const requirement of snapshot.requirements) {
      this.db
        .prepare(
          `INSERT INTO requirements (uuid, initiative_id, human_key, statement, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requirement.uuid,
          requirement.initiative_id,
          requirement.human_key,
          requirement.statement,
          requirement.createdAt,
          requirement.updatedAt,
          requirement.revision,
        );
      this.raiseCounterFloor(`requirement_human_key:${requirement.initiative_id}`, this.parseHumanKeyNumber(requirement.human_key));
    }

    for (const criterion of snapshot.acceptance_criteria) {
      this.db
        .prepare(
          `INSERT INTO acceptance_criteria (uuid, requirement_id, human_key, statement, check_reference, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          criterion.uuid,
          criterion.requirement_id,
          criterion.human_key,
          criterion.statement,
          criterion.check_reference,
          criterion.createdAt,
          criterion.updatedAt,
          criterion.revision,
        );
      this.raiseCounterFloor(
        `acceptance_criterion_human_key:${criterion.requirement_id}`,
        this.parseHumanKeyNumber(criterion.human_key),
      );
    }

    for (const decision of snapshot.decisions) {
      this.db
        .prepare(
          `INSERT INTO decisions (uuid, initiative_id, human_key, title, decision, rationale, alternatives, status, superseded_by, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.uuid,
          decision.initiative_id,
          decision.human_key,
          decision.title,
          decision.decision,
          decision.rationale,
          JSON.stringify(decision.alternatives),
          decision.status,
          decision.superseded_by,
          decision.createdAt,
          decision.updatedAt,
          decision.revision,
        );
      this.raiseCounterFloor(`decision_human_key:${decision.initiative_id}`, this.parseHumanKeyNumber(decision.human_key));
    }

    for (const item of snapshot.evidence) {
      this.db
        .prepare(
          `INSERT INTO evidence (uuid, initiative_id, kind, locator, content_hash, summary, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(item.uuid, item.initiative_id, item.kind, item.locator, item.content_hash, item.summary, item.createdAt, item.updatedAt, item.revision);
    }

    for (const risk of snapshot.risks) {
      this.db
        .prepare(
          `INSERT INTO risks (uuid, initiative_id, human_key, statement, severity, status, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(risk.uuid, risk.initiative_id, risk.human_key, risk.statement, risk.severity, risk.status, risk.createdAt, risk.updatedAt, risk.revision);
      this.raiseCounterFloor(`risk_human_key:${risk.initiative_id}`, this.parseHumanKeyNumber(risk.human_key));
    }

    for (const run of snapshot.verification_runs) {
      this.db
        .prepare(
          `INSERT INTO verification_runs (uuid, initiative_id, acceptance_criterion_id, method, state, detail, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(run.uuid, run.initiative_id, run.acceptance_criterion_id, run.method, run.state, run.detail, run.createdAt, run.revision);
    }

    for (const phaseRecord of snapshot.phase_records) {
      this.upsertPhaseRecord(initiative.uuid, phaseRecord.phase, phaseRecord.state);
    }

    for (const bundle of snapshot.deliverables) {
      const deliverable = bundle.deliverable;
      this.db
        .prepare(
          `INSERT INTO deliverables (uuid, initiative_id, target_type, delivery_contract, validation_state, validation_detail, delivery_reference, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deliverable.uuid,
          deliverable.initiative_id,
          deliverable.target_type,
          deliverable.delivery_contract,
          deliverable.validation_state,
          deliverable.validation_detail,
          deliverable.delivery_reference,
          deliverable.createdAt,
          deliverable.updatedAt,
          deliverable.revision,
        );
      for (const member of bundle.members) {
        this.db
          .prepare(`INSERT INTO deliverable_artifacts (deliverable_id, artifact_id, requirement, created_at) VALUES (?, ?, ?, ?)`)
          .run(member.deliverable_id, member.artifact_id, member.requirement, member.createdAt);
      }
      for (const history of bundle.history) {
        this.db
          .prepare(
            `INSERT INTO deliverable_delivery_history (uuid, deliverable_id, delivery_reference, validation_state, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(history.uuid, history.deliverable_id, history.delivery_reference, history.validation_state, history.createdAt);
      }
    }

    // Replay every snapshot Event with its ORIGINAL content (entity, type, payload, and full
    // caller provenance — never this mutation's OWN `provenance`), in original relative order.
    // `writeEvent` allocates a fresh `event_sequence` per call (MAX(event_sequence)+1), so a
    // truly fresh target store reproduces the exact original sequence numbers; a non-empty
    // target store still preserves relative order without colliding with unrelated rows.
    for (const event of snapshot.events) {
      this.writeEvent({
        entity_type: event.entity_type as Event['entity_type'],
        entity_id: event.entity_id,
        initiative_id: event.initiative_id,
        event_type: event.event_type,
        payload: event.payload,
        provenance: {
          actor_type: event.actor_type,
          actor_id: event.actor_id,
          interface: event.interface,
          initiated_by: event.initiated_by,
          authorized_by: event.authorized_by,
          timestamp: event.timestamp,
          source: event.source,
        },
      });
    }

    void provenance; // the caller's own provenance identifies the IMPORT act; every reconstructed
    // record and replayed Event above intentionally carries its ORIGINAL snapshot provenance
    // instead, so the imported history reads exactly as it did in the source store.
    return initiative;
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

/** Maps one raw `products` row to the public `Product` shape. */
function mapProductRow(row: ProductRow): Product {
  return {
    uuid: row.uuid,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `workspaces` row to the public `Workspace` shape. */
function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    uuid: row.uuid,
    product_id: row.product_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `resources` row to the public `Resource` shape. */
function mapResourceRow(row: ResourceRow): Resource {
  return {
    uuid: row.uuid,
    workspace_id: row.workspace_id,
    type: row.type,
    canonical_locator: row.canonical_locator,
    local_path: row.local_path,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `initiatives` row to the public `Initiative` shape. */
function mapInitiativeRow(row: InitiativeRow): Initiative {
  return {
    uuid: row.uuid,
    human_key: row.human_key,
    product_id: row.product_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
    focus_phase: row.focus_phase,
    lifecycle_contract: row.lifecycle_contract,
  };
}

/** Maps one raw `tasks` row to the public `Task` shape, parsing the JSON list columns. */
function mapTaskRow(row: TaskRow): Task {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    outcome: row.outcome,
    claimed_by: row.claimed_by ?? null,
    workspace_ids: JSON.parse(row.workspace_ids) as string[],
    resource_ids: JSON.parse(row.resource_ids) as string[],
    executionRefs: JSON.parse(row.execution_refs ?? '[]') as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
    method: row.method ?? null,
  };
}

/**
 * `initiative_task_execution`'s optional-transition matrix (SPEC-003 FR-9, "Interfaces / contracts").
 * Every (source status → listed target statuses) pair below is permitted; every unlisted pair —
 * including any pair with a `completed` or `cancelled` source, which never appears as a key — is
 * rejected as `invalid_task_transition`.
 */
const TASK_EXECUTION_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  open: ['in_progress'],
  claimed: ['in_progress'],
  in_progress: ['blocked', 'open', 'completed'],
  blocked: ['in_progress', 'open'],
};

/** Maps one raw `artifact_refs` row to the public `ArtifactRef` shape. */
function mapArtifactRefRow(row: ArtifactRefRow): ArtifactRef {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    storage_mode: row.storage_mode,
    path_or_uri: row.path_or_uri,
    content_hash: row.content_hash,
    media_type: row.media_type,
    version: row.version,
    produced_by_task: row.produced_by_task,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `deliverables` row to the public `Deliverable` shape. SPEC-007 Delivery Layer, Task I-3. */
function mapDeliverableRow(row: DeliverableRow): Deliverable {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    target_type: row.target_type,
    delivery_contract: row.delivery_contract,
    validation_state: row.validation_state,
    validation_detail: row.validation_detail,
    delivery_reference: row.delivery_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `deliverable_artifacts` row to the public `DeliverableArtifactMember` shape. SPEC-007 Delivery Layer, Task I-3. */
function mapDeliverableArtifactRow(row: DeliverableArtifactRow): DeliverableArtifactMember {
  return {
    deliverable_id: row.deliverable_id,
    artifact_id: row.artifact_id,
    requirement: row.requirement,
    createdAt: row.created_at,
  };
}

/** Maps one raw `deliverable_delivery_history` row to the public `DeliveryHistoryEntry` shape. SPEC-007 Delivery Layer, Task I-4. */
function mapDeliveryHistoryRow(row: DeliveryHistoryRow): DeliveryHistoryEntry {
  return {
    uuid: row.uuid,
    deliverable_id: row.deliverable_id,
    delivery_reference: row.delivery_reference,
    validation_state: row.validation_state,
    createdAt: row.created_at,
  };
}

/** Maps one raw `initiative_relations` row to the public `InitiativeRelation` shape, preserving direction. */
function mapRelationRow(row: RelationRow): InitiativeRelation {
  return {
    from_id: row.from_id,
    to_id: row.to_id,
    type: row.type,
    createdAt: row.created_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `decisions` row to the public `Decision` shape, parsing the JSON `alternatives` column. */
function mapDecisionRow(row: DecisionRow): Decision {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    human_key: row.human_key,
    title: row.title,
    decision: row.decision,
    rationale: row.rationale,
    alternatives: JSON.parse(row.alternatives) as string[],
    status: row.status,
    superseded_by: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `evidence_links` row to the public `EvidenceLink` shape (the sole Phase A1 record with no `uuid`). */
function mapEvidenceLinkRow(row: EvidenceLinkRow): EvidenceLink {
  return {
    evidence_id: row.evidence_id,
    target_type: row.target_type,
    target_id: row.target_id,
    createdAt: row.created_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `verification_runs` row to the public `VerificationRun` shape. */
function mapVerificationRunRow(row: VerificationRunRow): VerificationRun {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    acceptance_criterion_id: row.acceptance_criterion_id,
    method: row.method,
    state: row.state,
    detail: row.detail,
    createdAt: row.created_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `requirements` row to the public `Requirement` shape. */
function mapRequirementRow(row: RequirementRow): Requirement {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    human_key: row.human_key,
    statement: row.statement,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `acceptance_criteria` row to the public `AcceptanceCriterion` shape. */
function mapAcceptanceCriterionRow(row: AcceptanceCriterionRow): AcceptanceCriterion {
  return {
    uuid: row.uuid,
    requirement_id: row.requirement_id,
    human_key: row.human_key,
    statement: row.statement,
    check_reference: row.check_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `evidence` row to the public `Evidence` shape. */
function mapEvidenceRow(row: EvidenceRow): Evidence {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    kind: row.kind,
    locator: row.locator,
    content_hash: row.content_hash,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Maps one raw `risks` row to the public `Risk` shape. */
function mapRiskRow(row: RiskRow): Risk {
  return {
    uuid: row.uuid,
    initiative_id: row.initiative_id,
    human_key: row.human_key,
    statement: row.statement,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** The pinned resume-collection tie-breaker: `createdAt` ascending, then `uuid` ascending. */
function compareCreatedAtThenUuid(a: { createdAt: string; uuid: string }, b: { createdAt: string; uuid: string }): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.uuid !== b.uuid) {
    return a.uuid < b.uuid ? -1 : 1;
  }
  return 0;
}
