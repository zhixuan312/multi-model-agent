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
  | 'migration_backup_failed';

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

/** The frozen typed error union — the exact runtime counterpart of SPEC-001's `TypedError`. */
export type InitiativeError =
  | RevisionConflictError
  | CrossProductWorkspaceLinkError
  | NotFoundError
  | InvalidRequestError
  | MigrationBackupFailedError;

const INITIATIVE_ERROR_CTORS = [
  RevisionConflictError,
  CrossProductWorkspaceLinkError,
  NotFoundError,
  InvalidRequestError,
  MigrationBackupFailedError,
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
