import {
  RevisionConflictError,
  CrossProductWorkspaceLinkError,
  CrossInitiativeEvidenceLinkError,
  CrossInitiativeVerificationError,
  TaskNotClaimableError,
  TaskClaimConflictError,
  InvalidTaskTransitionError,
  InvalidPhaseTransitionError,
  UnknownLifecycleContractError,
  UnknownMethodError,
  UnknownDeliveryContractError,
  TargetAdapterValidationFailedError,
  VerificationMethodNotRunnableError,
  InitiativeAlreadyExistsError,
  InitiativeNotFoundError,
  InitiativeInvalidRequestError,
  MigrationBackupFailedError,
} from '@zhixuan92/multi-model-agent-core';

/**
 * What a typed Initiative error says, independent of the wire carrying it.
 *
 * `http/handlers/initiative-record.ts` and `mcp/mcp-adapter.ts` each held a ~120-line
 * `instanceof` chain over these same eighteen classes. Only the HTTP STATUS is genuinely
 * transport-specific: the code, the message and the per-class detail fields are properties of
 * the error itself, and stating them twice is how they drifted — MCP reported
 * `cross_initiative_evidence_link` with `{ evidence_id, target_type, target_id }` and
 * `cross_initiative_verification` with `{ initiative_id, acceptance_criterion_id }` while HTTP
 * reported neither, so an HTTP caller debugging a cross-Initiative link got a message and no ids.
 *
 * A new error class added here reaches both wires at once; one added to a transport instead
 * degrades to `internal_error` on the other, which is what `initiative-error-transport-parity`
 * fails on.
 */
export interface InitiativeErrorReport {
  code: string;
  message: string;
  /** Omitted, not empty, when the class carries no fields beyond its message. */
  details?: Record<string, unknown>;
  /** HTTP status for this class. The one genuinely transport-specific value; MCP ignores it. */
  status: number;
}

export function reportInitiativeError(err: unknown): InitiativeErrorReport {
  const base = (status: number, details?: Record<string, unknown>): InitiativeErrorReport => ({
    code: (err as { code: string }).code,
    message: (err as Error).message,
    ...(details ? { details } : {}),
    status,
  });

  if (err instanceof RevisionConflictError) {
    return base(409, {
      entity_type: err.entity_type,
      entity_id: err.entity_id,
      expected_revision: err.expected_revision,
      actual_revision: err.actual_revision,
    });
  }
  if (err instanceof CrossProductWorkspaceLinkError) {
    return base(409, { initiative_id: err.initiative_id, workspace_id: err.workspace_id });
  }
  if (err instanceof CrossInitiativeEvidenceLinkError) {
    return base(409, { evidence_id: err.evidence_id, target_type: err.target_type, target_id: err.target_id });
  }
  if (err instanceof CrossInitiativeVerificationError) {
    return base(409, { initiative_id: err.initiative_id, acceptance_criterion_id: err.acceptance_criterion_id });
  }
  if (err instanceof TaskNotClaimableError) {
    return base(409, { task_id: err.task_id, status: err.status });
  }
  if (err instanceof TaskClaimConflictError) {
    return base(409, { task_id: err.task_id, claimed_by: err.claimed_by, authorized_by: err.authorized_by });
  }
  if (err instanceof InvalidTaskTransitionError) {
    return base(409, { task_id: err.task_id, from_status: err.from_status, to_status: err.to_status });
  }
  if (err instanceof InvalidPhaseTransitionError) {
    return base(409, {
      initiative_id: err.initiative_id,
      phase: err.phase,
      source_state: err.source_state,
      target_state: err.target_state,
    });
  }
  if (err instanceof UnknownLifecycleContractError) {
    return base(400, { lifecycle_contract: err.lifecycle_contract });
  }
  if (err instanceof UnknownMethodError) {
    return base(400, { method: err.method });
  }
  if (err instanceof UnknownDeliveryContractError) {
    return base(400, { delivery_contract: err.delivery_contract });
  }
  if (err instanceof TargetAdapterValidationFailedError) {
    return base(400, { target_type: err.target_type });
  }
  if (err instanceof VerificationMethodNotRunnableError) {
    return base(400, { method: err.method });
  }
  if (err instanceof InitiativeAlreadyExistsError) {
    return base(409, { uuid: err.uuid, human_key: err.human_key });
  }
  if (err instanceof InitiativeNotFoundError) {
    return base(404, { entity_type: err.entity_type, lookup: err.lookup });
  }
  if (err instanceof InitiativeInvalidRequestError) {
    return base(400, { field_errors: err.field_errors });
  }
  if (err instanceof MigrationBackupFailedError) {
    return base(500, { database_path: err.database_path, backup_path: err.backup_path });
  }
  return {
    code: 'internal_error',
    message: err instanceof Error ? err.message : 'Unexpected error',
    status: 500,
  };
}
