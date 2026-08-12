/**
 * Initiative Record — public exports (Phase A0 kernel).
 *
 * Task I-1 keeps this barrel limited to the domain modules that exist after I-1:
 * types, schemas, errors, and the repository interface. Task I-2 adds the
 * `InitiativeRecordStore` and `runInitiativeMigrations` exports once
 * `sqlite-store.ts` and `migrations.ts` exist.
 */
export * from './types.js';
export * from './schemas.js';
export * from './errors.js';
export type { InitiativeRepository } from './repository.js';
