/**
 * Initiative Record — public exports (Phase A0 kernel).
 *
 * Task I-1: types, schemas, errors, and the repository interface. Task I-2
 * adds `InitiativeRecordStore` (the SQLite-backed store) and
 * `runInitiativeMigrations` (the backup-before-upgrade migration runner) now
 * that `sqlite-store.ts` and `migrations.ts` exist.
 *
 * SPEC-003 Phase B (Task I-1) extends this surface with `Task.claimed_by`,
 * the `initiative_task_claim` / `initiative_task_release` /
 * `initiative_task_complete` / `initiative_task_execution` operations, their
 * `task_not_claimable` / `task_claim_conflict` / `invalid_task_transition`
 * typed errors, and the additive `initiatives.db` schema version 3 migration
 * — all re-exported through the wildcard exports below, no new export list
 * required.
 *
 * SPEC-004 Lifecycle Engine (Task I-1) extends this surface with the
 * `Phase` / `PhaseRecordState` / `Satisfier` / `Establishment` / `PhaseRecord`
 * / `LifecycleContract` / `GateEstablishmentResult` / `GateStatus` /
 * `LifecycleResumeBlock` domain types, `Initiative.focus_phase` /
 * `Initiative.lifecycle_contract`, the `initiative_phase_enter` /
 * `_satisfy` / `_reopen` / `_skip` / `initiative_focus_set` /
 * `initiative_set_lifecycle_contract` mutations and read-only
 * `initiative_gate_status`, their `invalid_phase_transition` /
 * `unknown_lifecycle_contract` typed errors, and the additive
 * `initiatives.db` schema version 4 migration (seeded immutable
 * `default-sdl@1`) — all re-exported through the wildcard exports below, no
 * new export list required. Store BEHAVIOR (transitions, live gate
 * evaluation) is Task I-2/I-3; this task is the data contract only.
 */
export * from './types.js';
export * from './schemas.js';
export * from './errors.js';
export type {
  InitiativeRepository,
  InitiativeWorkspaceLinkRead,
  RelatedInitiativeRead,
  RequirementWithCriteriaRead,
  LatestVerificationRead,
} from './repository.js';
export { InitiativeRecordStore } from './sqlite-store.js';
export type { InitiativeRecordStorePragmas } from './sqlite-store.js';
export { runInitiativeMigrations, INITIATIVE_SCHEMA_VERSION } from './migrations.js';
export type { RunInitiativeMigrationsOptions, RunInitiativeMigrationsResult } from './migrations.js';
