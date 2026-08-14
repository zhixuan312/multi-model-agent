/**
 * Initiative Record — committed Delivery packager guidance resolver (SPEC-007 Delivery Layer,
 * Task I-9, ← AC-2.1).
 *
 * A resolved Delivery Contract (`store.getDeliveryContract()` / `.listDeliveryContracts()`,
 * Task I-1) names a declaration only — the frozen `id`, `name`, `version`, `target_type`,
 * `requires`, and `verification` fields. The bundle-assembly and self-check prose a packager
 * actually reads lives in a COMMITTED Markdown asset, never in `delivery_contracts.definition_json`
 * — the same declaration/guidance split SPEC-005 established for Method Procedure guidance
 * (`method-guidance.ts`). `loadDeliveryPackager(id)` is the sole reader of that asset.
 *
 * Path resolution is a fixed, non-caller-selectable mapping:
 * `packages/core/src/delivery-packagers/<name>/packager.md`, where `<name>` is the identifier
 * text before `@`. There is no override parameter and no fallback to any other directory — a
 * caller cannot point this resolver at a path it did not ship with (the "no caller-selected
 * path" invariant `method-guidance.ts` also holds).
 *
 * A packager asset gives bundle assembly and verification guidance ONLY — how to attach an
 * Artifact per `requires` entry and how to check each `verification` entry before a Deliverable
 * is treated as ready. It never configures, contacts, validates against, or hands off to a real
 * target; that behavior belongs exclusively to a registered `TargetAdapter` (`target-adapters.ts`).
 * This module resolves Markdown text only — it contains no target-specific delivery logic of its
 * own.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERY_CONTRACT_ID_PATTERN } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Running from `packages/core/src/initiative-record/` (monorepo dev, and every Vitest run —
 * Vitest transforms `.ts` in place, it does not read compiled output), the sibling
 * `delivery-packagers/` directory is one level up: `src/delivery-packagers`. Running from the
 * COMPILED package (`packages/core/dist/initiative-record/delivery-packagers.js`, the shape any
 * real npm consumer loads), `tsc` mirrors `src/` into `dist/` 1:1 but — like every other `*.md`
 * asset in this package — never copies non-`.ts` files, so `dist/delivery-packagers/` never
 * exists. The real `packager.md` files ship only under `src/delivery-packagers/` (see
 * `package.json` `"files"`), the same "keep Markdown next to `src/`, never emit it into `dist/`"
 * choice `method-guidance.ts` and `skills-dir.ts` document. Prefer the dev-shape path when it
 * exists; fall back to the package-root-relative `src/delivery-packagers` shape otherwise. This
 * is an existence check on a fixed, hardcoded pair of candidates — not a caller-selectable root.
 */
const DEV_DELIVERY_PACKAGERS_ROOT = resolve(here, '../delivery-packagers');
const INSTALLED_DELIVERY_PACKAGERS_ROOT = resolve(here, '../../src/delivery-packagers');
const DELIVERY_PACKAGERS_ROOT = existsSync(DEV_DELIVERY_PACKAGERS_ROOT)
  ? DEV_DELIVERY_PACKAGERS_ROOT
  : INSTALLED_DELIVERY_PACKAGERS_ROOT;

/**
 * The complete, immutable v1 catalog's asset mapping. Keeping the identifier in this mapping
 * (rather than deriving it from a directory scan) makes the production directory check
 * bidirectional: a missing seed asset and an orphan asset both fail deterministically — the same
 * shape `GUIDANCE_ASSET_IDS` gives `method-guidance.ts`.
 */
interface PackagerAsset {
  id: string;
  directory: string;
}

const PACKAGER_ASSETS = [
  { id: 'runnable-prototype@1', directory: 'runnable-prototype' },
  { id: 'runnable-software@1', directory: 'runnable-software' },
] as const satisfies readonly PackagerAsset[];

/**
 * Loads the committed bundle-assembly and verification guidance Markdown for a registered
 * Delivery Contract identifier (SPEC-007, Task I-9 ← AC-2.1). Resolves ONLY
 * `packages/core/src/delivery-packagers/<name>/packager.md` — no caller-selectable root, no
 * override, no fallback read from any other directory, and no SQLite read (the caller resolves
 * the identifier against `delivery_contracts` first, e.g. through
 * `InitiativeRecordStore.getDeliveryContract()`; this function's only input is the identifier
 * text).
 *
 * Throws a plain, descriptive `Error` — not a typed Initiative Record error — for an unknown
 * identifier or a missing/unreadable asset. The declaration-level `unknown_delivery_contract`
 * distinction belongs to the store (`UnknownDeliveryContractError`); this resolver's failure mode
 * is "no committed packager asset for this name," which can occur independently of whether the
 * identifier is registered (an orphaned seed with no matching asset is exactly the defect this
 * function's own failure surfaces).
 */
export function loadDeliveryPackager(id: string): string {
  return resolvePackagerFromRoot(id, DELIVERY_PACKAGERS_ROOT, PACKAGER_ASSETS);
}

/**
 * INTERNAL test seam — resolves a packager from an injectable root and mapping. It is deliberately
 * not re-exported from the Initiative Record barrel: production callers can only use the real,
 * fixed mapping and committed directory. The seam makes the resolver's declared drift failures
 * testable without mutating the shared committed asset tree during parallel test runs.
 */
export function resolveDeliveryPackagerFromRootForTest(
  id: string,
  root: string,
  assets: readonly PackagerAsset[] = PACKAGER_ASSETS,
): string {
  return resolvePackagerFromRoot(id, root, assets);
}

/** Checks the committed directory before any asset read, so drift cannot be hidden by a usable sibling asset. */
function assertPackagerAssetBijection(root: string, assets: readonly PackagerAsset[]): void {
  const expectedById = new Map<string, PackagerAsset>();
  const expectedDirectories = new Set<string>();
  for (const asset of assets) {
    if (expectedById.has(asset.id) || expectedDirectories.has(asset.directory)) {
      throw new Error(`duplicate committed packager mapping for Delivery Contract '${asset.id}'`);
    }
    expectedById.set(asset.id, asset);
    expectedDirectories.add(asset.directory);
  }
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { encoding: 'utf8', withFileTypes: true });
  } catch {
    throw new Error(`no committed packager assets directory (expected '${root}')`);
  }

  const actualDirectories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  for (const asset of assets) {
    if (!actualDirectories.has(asset.directory) || !existsSync(resolve(root, asset.directory, 'packager.md'))) {
      throw new Error(`missing committed packager asset for registered Delivery Contract '${asset.id}'`);
    }
  }
  for (const name of actualDirectories) {
    if (!expectedDirectories.has(name)) {
      throw new Error(`orphan committed packager asset '${name}/packager.md'`);
    }
  }
}

function resolvePackagerFromRoot(id: string, root: string, assets: readonly PackagerAsset[]): string {
  assertPackagerAssetBijection(root, assets);
  const asset = assets.find((candidate) => candidate.id === id);
  if (!DELIVERY_CONTRACT_ID_PATTERN.test(id) || !asset) {
    throw new Error(`unknown_delivery_contract: no committed packager asset is registered for Delivery Contract '${id}'`);
  }
  const assetPath = resolve(root, asset.directory, 'packager.md');
  try {
    return readFileSync(assetPath, 'utf8');
  } catch {
    throw new Error(`no committed packager asset for Delivery Contract '${id}' (expected '${assetPath}')`);
  }
}
