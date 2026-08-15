/**
 * The `exports` map IS the published API surface. Nothing checked it.
 *
 * Three defects, all in `packages/core/package.json`:
 *
 *  1. `./bounded-execution/activity-tracker` and `./reporting/structured-report` pointed at modules
 *     that no longer exist in `src` OR `dist` — the activity tracker went with the lifecycle layer.
 *     A consumer following the manifest got ERR_MODULE_NOT_FOUND from a path the package advertises.
 *
 *  2. `./providers/provider-factory` published the module holding
 *     `__setCoreTestProviderOverride` / `__setCoreTestProviderOverrideMap`. `index.ts` deliberately
 *     keeps those off the barrel, in a comment that names the exact hazard: "Exporting them made a
 *     global provider-swap hook part of the PUBLISHED api surface … any consumer, or anything in a
 *     consumer's dependency tree, could redirect every tier's provider process-wide."
 *
 *     The barrel omission accomplished nothing against that threat, because the subpath published
 *     the same module by another door. A boundary enforced in one of the two places that define it
 *     is not a boundary — and the only in-repo user of that subpath was a test importing
 *     `createProvider`, which the barrel exports anyway.
 *
 * The lesson generalises past these three: a manifest entry is code that nothing type-checks, no
 * test imports, and the compiler never sees. It can only be verified against the filesystem, which
 * is what this does.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Pkg {
  name: string;
  exports?: Record<string, { types?: string; import?: string }>;
}

const PACKAGES = ['packages/core', 'packages/server'];

/** Every (package, subpath, target) triple the two manifests advertise. */
const ENTRIES = PACKAGES.flatMap((dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;
  return Object.entries(pkg.exports ?? {}).flatMap(([sub, m]) =>
    (['types', 'import'] as const)
      .map((k) => m[k])
      .filter((t): t is string => t !== undefined)
      .map((target) => ({ dir, sub, target })),
  );
});

/** `./dist/foo/bar.js` → the source file it is built from. */
function sourceFor(dir: string, target: string): string {
  return join(dir, target.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts'));
}

describe('every published subpath resolves to a real module', () => {
  it('finds entries to check', () => {
    // Floor: an empty or unparsed map would make every case below vacuous.
    expect(ENTRIES.length).toBeGreaterThan(10);
  });

  it.each(ENTRIES.map((e) => [`${e.dir} ${e.sub} → ${e.target}`, e] as const))(
    '%s',
    (_label, e) => {
      expect(
        existsSync(sourceFor(e.dir, e.target)),
        `${e.dir}/package.json advertises "${e.sub}" but ${sourceFor(e.dir, e.target)} does not exist`,
      ).toBe(true);
    },
  );
});

describe('no published subpath exposes a test seam', () => {
  /**
   * A seam is a module-level export that exists only so tests can reach inside — this repo marks
   * them with a `__` prefix or a `ForTest(s)` suffix, and index.ts calls keeping them off the barrel
   * "this repo's settled rule". The rule has to hold for subpaths too, or the barrel omission is
   * decorative.
   */
  const SEAM = /^\s*export\s+(?:async\s+)?(?:function|const|class)\s+(__\w+|\w*[Ff]orTests?)\b/gm;

  it('the seam pattern matches the seams that exist', () => {
    // Floor: a pattern matching nothing would pass every case below without checking anything.
    const factory = readFileSync('packages/core/src/providers/provider-factory.ts', 'utf8');
    expect([...factory.matchAll(SEAM)].length, 'the seam regex no longer matches known seams')
      .toBeGreaterThan(0);
  });

  it.each([...new Set(ENTRIES.map((e) => `${e.dir}|${e.sub}|${e.target}`))])('%s', (key) => {
    const [dir, sub, target] = key.split('|') as [string, string, string];
    const src = sourceFor(dir, target);
    if (!existsSync(src)) return; // covered by the suite above
    const found = [...readFileSync(src, 'utf8').matchAll(SEAM)].map((m) => m[1]);
    expect(
      found,
      `${dir}/package.json publishes "${sub}", which exposes test seam(s) ${found.join(', ')} to every consumer`,
    ).toEqual([]);
  });
});
