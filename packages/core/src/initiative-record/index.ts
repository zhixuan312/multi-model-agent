/**
 * Initiative Record — public exports (Phase A0 kernel).
 *
 * Task I-1: types, schemas, errors, and the repository interface. Task I-2
 * adds `InitiativeRecordStore` (the SQLite-backed store) and
 * `runInitiativeMigrations` (the backup-before-upgrade migration runner) now
 * that `sqlite-store.ts` and `migrations.ts` exist.
 */
export * from './types.js';
export * from './schemas.js';
export * from './errors.js';
export type { InitiativeRepository } from './repository.js';
export { InitiativeRecordStore } from './sqlite-store.js';
export type { InitiativeRecordStorePragmas } from './sqlite-store.js';
export { runInitiativeMigrations, INITIATIVE_SCHEMA_VERSION } from './migrations.js';
export type { RunInitiativeMigrationsOptions, RunInitiativeMigrationsResult } from './migrations.js';
