/**
 * Initiative Record — the frozen typed error union (SPEC-001, "Interfaces / contracts").
 *
 * TRANSCRIPTION, not design: these five variants, and exactly these fields per variant,
 * are pinned by the specification's `TypedError` union. No domain failure is represented
 * as an untyped string or a partially successful result — every repository and service
 * failure documented in SPEC-001 throws one of these.
 */

export type InitiativeErrorCode =
  | 'revision_conflict'
  | 'cross_product_workspace_link'
  | 'not_found'
  | 'invalid_request'
  | 'migration_backup_failed'
  | 'cross_initiative_evidence_link'
  | 'cross_initiative_verification'
  | 'task_not_claimable'
  | 'task_claim_conflict'
  | 'invalid_task_transition'
  | 'invalid_phase_transition'
  | 'unknown_lifecycle_contract';

/** A mutation's `expected_revision` did not match the stored revision (FR-7, AC-1.4). */
export class RevisionConflictError extends Error {
  readonly code = 'revision_conflict' as const;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(params: {
    entity_type: string;
    entity_id: string;
    expected_revision: number;
    actual_revision: number;
    message?: string;
  }) {
    super(
      params.message ??
        `revision_conflict: ${params.entity_type} ${params.entity_id}: expected ${params.expected_revision}, actual ${params.actual_revision}`,
    );
    this.name = 'RevisionConflictError';
    this.entity_type = params.entity_type;
    this.entity_id = params.entity_id;
    this.expected_revision = params.expected_revision;
    this.actual_revision = params.actual_revision;
  }
}

/** `initiative_link_workspace` targeted a Workspace outside the Initiative's Product (FR-11, AC-1.7). */
export class CrossProductWorkspaceLinkError extends Error {
  readonly code = 'cross_product_workspace_link' as const;
  readonly initiative_id: string;
  readonly workspace_id: string;

  constructor(params: { initiative_id: string; workspace_id: string; message?: string }) {
    super(
      params.message ??
        `cross_product_workspace_link: Initiative ${params.initiative_id} may not link to Workspace ${params.workspace_id}: different Product`,
    );
    this.name = 'CrossProductWorkspaceLinkError';
    this.initiative_id = params.initiative_id;
    this.workspace_id = params.workspace_id;
  }
}

/** A `get`, `status`, `relate`, or link lookup did not resolve to a stored record. */
export class NotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly entity_type: string;
  readonly lookup: string;

  constructor(params: { entity_type: string; lookup: string; message?: string }) {
    super(params.message ?? `not_found: ${params.entity_type} not found: ${params.lookup}`);
    this.name = 'NotFoundError';
    this.entity_type = params.entity_type;
    this.lookup = params.lookup;
  }
}

/**
 * A request failed boundary validation (malformed Zod input, an idempotency-key reuse
 * with different business input, or a status/outcome pairing rejection) before any write.
 */
export class InvalidRequestError extends Error {
  readonly code = 'invalid_request' as const;
  readonly field_errors: Record<string, string[]>;

  constructor(params: { field_errors: Record<string, string[]>; message?: string }) {
    super(params.message ?? 'invalid_request: Invalid request');
    this.name = 'InvalidRequestError';
    this.field_errors = params.field_errors;
  }
}

/** A versioned migration's backup-before-upgrade step failed or could not be verified (FR-12). */
export class MigrationBackupFailedError extends Error {
  readonly code = 'migration_backup_failed' as const;
  readonly database_path: string;
  readonly backup_path: string;

  constructor(params: { database_path: string; backup_path: string; message?: string }) {
    super(params.message ?? `Migration backup failed for ${params.database_path} (backup ${params.backup_path})`);
    this.name = 'MigrationBackupFailedError';
    this.database_path = params.database_path;
    this.backup_path = params.backup_path;
  }
}

/** `evidence_link` targeted a record outside the Evidence's own Initiative (SPEC-002 FR-8). */
export class CrossInitiativeEvidenceLinkError extends Error {
  readonly code = 'cross_initiative_evidence_link' as const;
  readonly evidence_id: string;
  readonly target_type: string;
  readonly target_id: string;

  constructor(params: { evidence_id: string; target_type: string; target_id: string; message?: string }) {
    super(
      params.message ??
        `cross_initiative_evidence_link: Evidence ${params.evidence_id} may not link to ${params.target_type} ${params.target_id}: different Initiative`,
    );
    this.name = 'CrossInitiativeEvidenceLinkError';
    this.evidence_id = params.evidence_id;
    this.target_type = params.target_type;
    this.target_id = params.target_id;
  }
}

/** `verification_record`'s `acceptance_criterion_id` resolves (via its Requirement) to a different Initiative (SPEC-002 "Interfaces / contracts"). */
export class CrossInitiativeVerificationError extends Error {
  readonly code = 'cross_initiative_verification' as const;
  readonly initiative_id: string;
  readonly acceptance_criterion_id: string;

  constructor(params: { initiative_id: string; acceptance_criterion_id: string; message?: string }) {
    super(
      params.message ??
        `cross_initiative_verification: AcceptanceCriterion ${params.acceptance_criterion_id} does not belong to Initiative ${params.initiative_id}`,
    );
    this.name = 'CrossInitiativeVerificationError';
    this.initiative_id = params.initiative_id;
    this.acceptance_criterion_id = params.acceptance_criterion_id;
  }
}

/** A claim was attempted on a Task whose status is not `open` (SPEC-003 FR-9, AC-1.7). */
export class TaskNotClaimableError extends Error {
  readonly code = 'task_not_claimable' as const;
  readonly task_id: string;
  readonly status: string;

  constructor(params: { task_id: string; status: string; message?: string }) {
    super(
      params.message ?? `task_not_claimable: Task ${params.task_id} cannot be claimed from status '${params.status}'`,
    );
    this.name = 'TaskNotClaimableError';
    this.task_id = params.task_id;
    this.status = params.status;
  }
}

/**
 * A `initiative_task_release`, `initiative_task_complete`, or ownership-gated
 * `initiative_task_execution` transition was attempted by a caller other than
 * the Task's claimant (SPEC-003 FR-9, AC-1.10). Release additionally exempts
 * `provenance.actor_type: 'human'` — the store applies that override before
 * throwing this error, never after.
 */
export class TaskClaimConflictError extends Error {
  readonly code = 'task_claim_conflict' as const;
  readonly task_id: string;
  readonly claimed_by: string | null;
  readonly authorized_by: string;

  constructor(params: { task_id: string; claimed_by: string | null; authorized_by: string; message?: string }) {
    super(
      params.message ??
        `task_claim_conflict: Task ${params.task_id} is claimed by ${JSON.stringify(params.claimed_by)}, not ${params.authorized_by}`,
    );
    this.name = 'TaskClaimConflictError';
    this.task_id = params.task_id;
    this.claimed_by = params.claimed_by;
    this.authorized_by = params.authorized_by;
  }
}

/** An unlisted Task status transition, or a `completed` transition missing a non-null outcome (SPEC-003 FR-9). */
export class InvalidTaskTransitionError extends Error {
  readonly code = 'invalid_task_transition' as const;
  readonly task_id: string;
  readonly from_status: string;
  readonly to_status: string;

  constructor(params: { task_id: string; from_status: string; to_status: string; message?: string }) {
    super(
      params.message ??
        `invalid_task_transition: Task ${params.task_id} cannot transition from '${params.from_status}' to '${params.to_status}'`,
    );
    this.name = 'InvalidTaskTransitionError';
    this.task_id = params.task_id;
    this.from_status = params.from_status;
    this.to_status = params.to_status;
  }
}

/**
 * An `initiative_phase_enter` / `_satisfy` / `_reopen` / `_skip` mutation named a source
 * Phase Record state outside that operation's legal transition set (SPEC-004 FR-2, "Data
 * model" transition table).
 */
export class InvalidPhaseTransitionError extends Error {
  readonly code = 'invalid_phase_transition' as const;
  readonly initiative_id: string;
  readonly phase: string;
  readonly source_state: string;
  readonly target_state: string;

  constructor(params: { initiative_id: string; phase: string; source_state: string; target_state: string; message?: string }) {
    super(
      params.message ??
        `invalid_phase_transition: Initiative ${params.initiative_id} phase '${params.phase}' cannot transition from '${params.source_state}' to '${params.target_state}'`,
    );
    this.name = 'InvalidPhaseTransitionError';
    this.initiative_id = params.initiative_id;
    this.phase = params.phase;
    this.source_state = params.source_state;
    this.target_state = params.target_state;
  }
}

/**
 * `initiative_create` or `initiative_set_lifecycle_contract` named a non-null `lifecycle_contract`
 * id with no matching row in `lifecycle_contracts` (SPEC-004 FR-7).
 */
export class UnknownLifecycleContractError extends Error {
  readonly code = 'unknown_lifecycle_contract' as const;
  readonly lifecycle_contract: string;

  constructor(params: { lifecycle_contract: string; message?: string }) {
    super(
      params.message ?? `unknown_lifecycle_contract: no registered Lifecycle Contract '${params.lifecycle_contract}'`,
    );
    this.name = 'UnknownLifecycleContractError';
    this.lifecycle_contract = params.lifecycle_contract;
  }
}

/** The frozen typed error union — the exact runtime counterpart of SPEC-001's `TypedError`, extended by SPEC-002, SPEC-003, and SPEC-004. */
export type InitiativeError =
  | RevisionConflictError
  | CrossProductWorkspaceLinkError
  | NotFoundError
  | InvalidRequestError
  | MigrationBackupFailedError
  | CrossInitiativeEvidenceLinkError
  | CrossInitiativeVerificationError
  | TaskNotClaimableError
  | TaskClaimConflictError
  | InvalidTaskTransitionError
  | InvalidPhaseTransitionError
  | UnknownLifecycleContractError;

const INITIATIVE_ERROR_CTORS = [
  RevisionConflictError,
  CrossProductWorkspaceLinkError,
  NotFoundError,
  InvalidRequestError,
  MigrationBackupFailedError,
  CrossInitiativeEvidenceLinkError,
  CrossInitiativeVerificationError,
  TaskNotClaimableError,
  TaskClaimConflictError,
  InvalidTaskTransitionError,
  InvalidPhaseTransitionError,
  UnknownLifecycleContractError,
] as const;

export function isInitiativeError(err: unknown): err is InitiativeError {
  return INITIATIVE_ERROR_CTORS.some((ctor) => err instanceof ctor);
}

/** Flattens a `ZodError`-shaped issue list into the `field_errors` shape `InvalidRequestError` carries. */
export function fieldErrorsFromIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_root';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}
