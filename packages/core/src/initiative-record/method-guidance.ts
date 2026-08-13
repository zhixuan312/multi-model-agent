/**
 * Initiative Record — committed Method procedure guidance resolver (SPEC-005 Method Registry,
 * Task I-2, ← AC-1.3).
 *
 * A resolved Method (`store.getMethod()` / `store.listMethods()`, this same task) names a
 * declaration only — the frozen `id`, `name`, `version`, `purpose`, `required_inputs`,
 * `expected_outputs`, and `verification_expectations` fields. The Procedure prose a worker
 * actually reads lives in a COMMITTED Markdown asset, never in `methods.definition_json`
 * (SPEC-005 "Data model" — declaration and guidance are deliberately separate artifacts).
 * `loadMethodGuidance(id)` is the sole reader of that asset.
 *
 * Path resolution is a fixed, non-caller-selectable mapping:
 * `packages/core/src/methods/<name>/guidance.md`, where `<name>` is the identifier text before
 * `@`. There is no override parameter and no fallback to any other directory — a caller cannot
 * point this resolver at a path it did not ship with (the "no caller-selected path" invariant).
 * That is also why the public export takes only `id`: adding a root/override parameter here
 * would itself violate the invariant this module exists to hold.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_ID_PATTERN } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Running from `packages/core/src/initiative-record/` (monorepo dev, and every Vitest run —
 * Vitest transforms `.ts` in place, it does not read compiled output), the sibling `methods/`
 * directory is one level up: `src/methods`. Running from the COMPILED package
 * (`packages/core/dist/initiative-record/method-guidance.js`, the shape any real npm consumer
 * loads), `tsc` mirrors `src/` into `dist/` 1:1 but — like every other `*.md` skill asset in
 * this package — never copies non-`.ts` files, so `dist/methods/` never exists. The real
 * `guidance.md` files ship only under `src/methods/` (see `package.json` `"files"`), the same
 * "keep Markdown next to `src/`, never emit it into `dist/`" choice `skills-dir.ts` documents
 * for the per-type skill assets. Prefer the dev-shape path when it exists; fall back to the
 * package-root-relative `src/methods` shape otherwise. This is a existence check on a fixed,
 * hardcoded pair of candidates — not a caller-selectable root.
 */
const DEV_METHODS_ROOT = resolve(here, '../methods');
const INSTALLED_METHODS_ROOT = resolve(here, '../../src/methods');
const METHODS_ROOT = existsSync(DEV_METHODS_ROOT) ? DEV_METHODS_ROOT : INSTALLED_METHODS_ROOT;

/**
 * The complete, immutable v1 catalog's asset mapping. Keeping the identifier in this mapping
 * (rather than deriving it from a directory scan) makes the production directory check
 * bidirectional: a missing seed asset and an orphan asset both fail deterministically.
 */
const GUIDANCE_ASSET_IDS = [
  'architecture-review@1',
  'regulatory-assessment@1',
  'research@1',
  'risk-analysis@1',
  'software-change@1',
  'solution-design@1',
  'source-validation@1',
  'technical-writing@1',
  'workflow-design@1',
] as const;

/**
 * Loads the committed procedure guidance Markdown for a registered Method identifier
 * (SPEC-005 FR-2/FR-3, Task I-2 ← AC-1.3). Resolves ONLY
 * `packages/core/src/methods/<name>/guidance.md` — no caller-selectable root, no override, no
 * fallback read from any other directory, and no SQLite read (the caller resolves the
 * identifier against `methods` first, e.g. through `InitiativeRecordStore.getMethod()`; this
 * function's only input is the identifier text).
 *
 * Throws a plain, descriptive `Error` — not a typed Initiative Record error — for a missing or
 * unreadable asset. The declaration-level `unknown_method` distinction belongs to the store
 * (`UnknownMethodError`); this resolver's failure mode is "no committed guidance asset for this
 * name," which can occur independently of whether the identifier is registered (an orphaned
 * seed with no matching asset is exactly the defect this function's own failure surfaces).
 */
export function loadMethodGuidance(id: string): string {
  assertGuidanceAssetBijection(METHODS_ROOT);
  return resolveGuidanceFromRoot(id, METHODS_ROOT);
}

/**
 * INTERNAL test seam — resolves guidance from an INJECTABLE root instead of the real committed
 * `packages/core/src/methods/` tree. Deliberately NOT re-exported from the `initiative-record`
 * barrel (`index.ts`): its only purpose is letting
 * `tests/initiative-record/method-guidance-assets.test.ts` prove the no-fallback-read invariant
 * against an empty throwaway directory, without touching a real committed asset. The suite runs
 * on a fork pool, so renaming or deleting `packages/core/src/methods/software-change/guidance.md`
 * mid-run would race every other test that reads that same tree; pointing this seam at a fresh
 * `mkdtemp` directory instead has no such race. `loadMethodGuidance` itself never exposes this
 * parameter — that is the invariant this seam exists to prove, not to weaken.
 */
export function resolveGuidanceFromRootForTest(id: string, root: string): string {
  assertGuidanceAssetBijection(root);
  return resolveGuidanceFromRoot(id, root);
}

/** Checks the committed directory before any asset read, so drift cannot be hidden by a usable sibling asset. */
function assertGuidanceAssetBijection(root: string): void {
  const expected = new Set(GUIDANCE_ASSET_IDS.map((id) => id.slice(0, id.indexOf('@'))));
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { encoding: 'utf8', withFileTypes: true });
  } catch {
    throw new Error(`no committed guidance assets directory (expected '${root}')`);
  }

  const actual = new Set(
    entries
      .filter((entry) => entry.isDirectory() && existsSync(resolve(root, entry.name, 'guidance.md')))
      .map((entry) => entry.name),
  );
  for (const name of expected) {
    if (!actual.has(name)) {
      throw new Error(`missing committed guidance asset for registered Method '${name}@1'`);
    }
  }
  for (const name of actual) {
    if (!expected.has(name)) {
      throw new Error(`orphan committed guidance asset '${name}/guidance.md'`);
    }
  }
}

function resolveGuidanceFromRoot(id: string, root: string): string {
  if (!METHOD_ID_PATTERN.test(id) || !GUIDANCE_ASSET_IDS.includes(id as (typeof GUIDANCE_ASSET_IDS)[number])) {
    throw new Error(`unknown_method: no committed guidance asset is registered for Method '${id}'`);
  }
  const name = id.slice(0, id.indexOf('@'));
  const assetPath = resolve(root, name, 'guidance.md');
  try {
    return readFileSync(assetPath, 'utf8');
  } catch {
    throw new Error(`no committed guidance asset for Method '${id}' (expected '${assetPath}')`);
  }
}
