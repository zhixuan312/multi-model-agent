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
 * `initiativeResume` is itself one frozen operation (FR-13): a concrete
 * implementation assembles `InitiativeResumeResponse` server-side in one call: no
 * caller-visible read method decomposition is part of this contract.
 */
import type { InitiativeMutationRequest } from './schemas.js';
import type { InitiativeRecordEntity } from './types.js';

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
}
