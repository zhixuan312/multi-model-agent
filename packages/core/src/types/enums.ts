import { z } from 'zod';

export type FindingsOutcome = 'found' | 'clean' | 'not_applicable';

/**
 * Filesystem confinement for a worker session.
 *
 * Declared HERE, in the substrate, rather than in `unified/type-registry.ts` where it used to live.
 * It describes what a PROVIDER does — `cwd-only` adds the claude PreToolUse confinement hook and
 * maps to codex `-s workspace-write`; `read-only` blocks every write tool — and the orchestration
 * layer is a consumer of that concept, not its owner.
 *
 * The old direction cost twice over. `providers/claude-cwd-confinement.ts` imported it from
 * `unified/`, violating the `no-substrate-to-unified` cruiser rule — invisibly, because the rule
 * could not see type-only imports until `tsPreCompilationDeps` was turned on. And
 * `types/run-result.ts` declared its own inline copy of the union with the comment "Typed inline to
 * avoid importing from `unified/`" — a second definition of two string literals, free to drift from
 * the first.
 */
export type SandboxPolicy = 'read-only' | 'cwd-only';

export const ConcernCategory = z.enum([
  'missing_test', 'scope_creep', 'incomplete_impl', 'style_lint', 'security',
  'performance', 'maintainability', 'doc_gap', 'doc_drift', 'contract_violation',
  'coverage_gap', 'dead_code', 'queue_hygiene', 'other',
]);

export type ConcernCategoryType = z.infer<typeof ConcernCategory>;
