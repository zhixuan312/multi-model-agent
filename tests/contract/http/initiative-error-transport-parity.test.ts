import { describe, expect, it } from 'vitest';
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
import { __initiativeErrorToHttpForTests } from '../../../packages/server/src/http/handlers/initiative-record.js';
import { __initiativeErrorToMcpForTests } from '../../../packages/server/src/mcp/mcp-adapter.js';

/**
 * One typed-error union, two transports, one set of diagnostics.
 *
 * `initiativeErrorToHttp` and `initiativeErrorToMcp` are ~120-line `instanceof` chains over the
 * SAME eighteen error classes, written out twice. Only the HTTP status is genuinely
 * transport-specific; the code, the message and the per-class detail fields are properties of
 * the error, and stating them twice is how they drifted: MCP reported
 * `cross_initiative_evidence_link` with `{ evidence_id, target_type, target_id }` and
 * `cross_initiative_verification` with `{ initiative_id, acceptance_criterion_id }` while HTTP
 * reported neither — an HTTP caller debugging a cross-Initiative link got the message and no ids.
 *
 * Every class is listed here with a constructed instance, so a NEW error class added to only one
 * mapper fails this file rather than silently degrading to `internal_error` on the other wire.
 */
const CASES: Array<{ name: string; err: unknown }> = [
  { name: 'RevisionConflictError', err: new RevisionConflictError({ entity_type: 'task', entity_id: 't-1', expected_revision: 3, actual_revision: 4 }) },
  { name: 'CrossProductWorkspaceLinkError', err: new CrossProductWorkspaceLinkError({ initiative_id: 'i-1', workspace_id: 'w-1' }) },
  { name: 'CrossInitiativeEvidenceLinkError', err: new CrossInitiativeEvidenceLinkError({ evidence_id: 'e-1', target_type: 'task', target_id: 't-1' }) },
  { name: 'CrossInitiativeVerificationError', err: new CrossInitiativeVerificationError({ initiative_id: 'i-1', acceptance_criterion_id: 'ac-1' }) },
  { name: 'TaskNotClaimableError', err: new TaskNotClaimableError({ task_id: 't-1', status: 'done' }) },
  { name: 'TaskClaimConflictError', err: new TaskClaimConflictError({ task_id: 't-1', claimed_by: 'a', authorized_by: 'b' }) },
  { name: 'InvalidTaskTransitionError', err: new InvalidTaskTransitionError({ task_id: 't-1', from_status: 'open', to_status: 'done' }) },
  { name: 'InvalidPhaseTransitionError', err: new InvalidPhaseTransitionError({ initiative_id: 'i-1', phase: 'discover', source_state: 'open', target_state: 'closed' }) },
  { name: 'UnknownLifecycleContractError', err: new UnknownLifecycleContractError({ lifecycle_contract: 'nope@1' }) },
  { name: 'UnknownMethodError', err: new UnknownMethodError({ method: 'nope@1' }) },
  { name: 'UnknownDeliveryContractError', err: new UnknownDeliveryContractError({ delivery_contract: 'nope@1' }) },
  { name: 'TargetAdapterValidationFailedError', err: new TargetAdapterValidationFailedError({ target_type: 'git-pr' }) },
  { name: 'VerificationMethodNotRunnableError', err: new VerificationMethodNotRunnableError({ method: 'human' }) },
  { name: 'InitiativeAlreadyExistsError', err: new InitiativeAlreadyExistsError({ uuid: 'u-1', human_key: 'key-1' }) },
  { name: 'InitiativeNotFoundError', err: new InitiativeNotFoundError({ entity_type: 'task', lookup: 't-1' }) },
  { name: 'InitiativeInvalidRequestError', err: new InitiativeInvalidRequestError({ field_errors: { title: ['required'] } }) },
  { name: 'MigrationBackupFailedError', err: new MigrationBackupFailedError({ database_path: '/db', backup_path: '/db.bak' }) },
];

function mcpPayload(err: unknown): { code: string; message: string; details: Record<string, unknown> } {
  const result = __initiativeErrorToMcpForTests(err) as { content: Array<{ text: string }> };
  const { error } = JSON.parse(result.content[0]!.text) as { error: Record<string, unknown> };
  const { code, message, ...details } = error;
  return { code: code as string, message: message as string, details };
}

describe('contract: initiative typed errors report identically on both transports', () => {
  it.each(CASES)('$name carries the same code and details over HTTP and MCP', ({ err }) => {
    const http = __initiativeErrorToHttpForTests(err);
    const mcp = mcpPayload(err);

    expect(http.code, 'neither transport may fall through to internal_error').not.toBe('internal_error');
    expect(mcp.code).toBe(http.code);
    expect(mcp.message).toBe(http.message);
    expect(mcp.details).toEqual((http.details ?? {}) as Record<string, unknown>);
  });

  it('an unclassified error is internal_error on both, not a leaked stack', () => {
    const err = new Error('something unexpected');
    expect(__initiativeErrorToHttpForTests(err)).toMatchObject({ status: 500, code: 'internal_error' });
    expect(mcpPayload(err).code).toBe('internal_error');
  });
});
