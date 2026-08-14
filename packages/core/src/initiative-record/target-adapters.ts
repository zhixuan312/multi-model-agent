/**
 * Initiative Record — public generic `TargetAdapter` registry (SPEC-007 Delivery Layer,
 * Task I-2, ← AC-1.4, AC-1.9).
 *
 * This is the FIRST production runtime plugin seam in the codebase — `createProvider`
 * (`providers/provider-factory.ts`) is a closed `claude`/`codex` switch with direct concrete
 * imports, and its only override is test-only. This registry proves the opposite property: a
 * caller can add a `TargetAdapter` at runtime, keyed by its own opaque `target_type` string,
 * without editing any core switch, union, or import list (SPEC-007 FR-8, "Goals" #3).
 *
 * The registry is process-local (an in-memory `Map`, not a table — adapters are code, not
 * data) and generic: `registerTargetAdapter` / `resolveTargetAdapter` accept and return only
 * the `TargetAdapter` shape declared in `types.ts` (`target_type` plus a `validate` function
 * over a generic Deliverable, its Delivery Contract, and its joined membership). This module
 * ships beside `method-guidance.ts` — the maintainer confirmed this path because both modules
 * are record-adjacent resolution seams, not provider concerns (see the plan's "Reconciliation
 * notes").
 *
 * This module registers NO adapter of its own, names no shipped or fake target, and contains
 * no target-specific field, switch, or direct target import — Task I-5's source scan proves
 * that boundary holds for `packages/core/src/` as a whole; the fake adapter used to prove the
 * seam is real lives only in a test file, never here.
 */
import { DuplicateTargetAdapterError } from './errors.js';
import type { TargetAdapter } from './types.js';

/** Process-local: one opaque `target_type` string maps to at most one registered adapter. */
const registry = new Map<string, TargetAdapter>();

/**
 * Registers a `TargetAdapter` under its own `target_type`. Throws `DuplicateTargetAdapterError`
 * (conflict-shaped, ← Task I-8 maps it to HTTP 409) when that `target_type` already has a
 * registered adapter — a registry keyed by `target_type` cannot silently accept a second
 * adapter for the same key without losing the first adapter's identity.
 */
export function registerTargetAdapter(adapter: TargetAdapter): void {
  if (registry.has(adapter.target_type)) {
    throw new DuplicateTargetAdapterError({ target_type: adapter.target_type });
  }
  registry.set(adapter.target_type, adapter);
}

/**
 * Resolves the `TargetAdapter` registered for `targetType`, or `null` when no adapter is
 * registered for that key. A missing adapter is not an error — Task I-4's `deliverable_validate`
 * treats it as "use contract completeness only" (SPEC-007 FR-8).
 */
export function resolveTargetAdapter(targetType: string): TargetAdapter | null {
  return registry.get(targetType) ?? null;
}
