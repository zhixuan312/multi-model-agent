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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * The suite cannot see the `exports` map at all, so this asks Node directly.
 *
 * `vitest.config.ts` aliases `@zhixuan92/multi-model-agent-core/(.+)` to `packages/core/src/$1.ts`.
 * That is the right call for unit tests — they run against source, not a build — but it means every
 * import in this repo bypasses the manifest. A subpath could be deleted, misspelled, or point at a
 * file that does not exist, and 3,500 green tests would prove nothing about it. The checks above
 * verify the manifest against the FILESYSTEM, which is a good proxy; this verifies it against the
 * RESOLVER, which is the thing consumers actually meet.
 *
 * The child runs from `packages/server`, NOT the repo root. That is the only resolution root pnpm
 * guarantees: `packages/server` declares `@zhixuan92/multi-model-agent-core: workspace:^`, so pnpm
 * links it into `packages/server/node_modules`. The repo root declares no such dependency, so a
 * root-level `node_modules/@zhixuan92/*` link exists only by accident of a developer's install
 * history — mine had one, CI did not, and the first version of this test failed all sixteen
 * subpaths on a GitHub runner while passing locally. It is also the more faithful root: a real
 * consumer resolves core as a dependency of the server package, which is exactly what this now does.
 *
 * One child process imports every declared subpath, so the cost is one spawn, not sixteen.
 */
describe('real Node resolves every declared subpath', () => {
  const CORE = 'packages/core';
  /** Resolve from the package that actually depends on core — see the note above. */
  const CORE_RESOLUTION_ROOT = 'packages/server';
  const declared = Object.keys(
    (JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as Pkg).exports ?? {},
  );

  it('resolves what the map declares, and blocks what it does not', () => {
    if (!existsSync(join(CORE, 'dist/index.js'))) {
      throw new Error('packages/core/dist is missing — run `npm run build` before this suite');
    }
    // Distinguish "the package is not linked here" from "the exports map is broken". Without this,
    // a missing link reports every subpath as ERR_MODULE_NOT_FOUND and reads like sixteen manifest
    // bugs, which is precisely how the first CI failure presented.
    if (!existsSync(join(CORE_RESOLUTION_ROOT, 'node_modules/@zhixuan92/multi-model-agent-core'))) {
      throw new Error(
        `@zhixuan92/multi-model-agent-core is not linked into ${CORE_RESOLUTION_ROOT}/node_modules `
        + '— run `pnpm install`. This is a workspace-link problem, not an exports-map problem.',
      );
    }
    const specs = declared.map((s) => `@zhixuan92/multi-model-agent-core${s === '.' ? '' : s.slice(1)}`);
    // Removed in this change; a consumer must no longer be able to reach the provider-swap hook.
    const mustFail = ['@zhixuan92/multi-model-agent-core/providers/provider-factory'];

    const script = `
      const ok = [], bad = [];
      for (const s of ${JSON.stringify([...specs, ...mustFail])}) {
        try { await import(s); ok.push(s); } catch (e) { bad.push([s, e.code ?? String(e)]); }
      }
      console.log(JSON.stringify({ ok, bad }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: CORE_RESOLUTION_ROOT,
      encoding: 'utf8',
    });
    const { ok, bad } = JSON.parse(out.trim().split('\n').pop()!) as {
      ok: string[];
      bad: [string, string][];
    };

    expect(ok.length + bad.length, 'the child imported nothing — this case would be vacuous')
      .toBe(specs.length + mustFail.length);

    const declaredFailures = bad.filter(([s]) => specs.includes(s));
    expect(declaredFailures, 'declared subpaths that real Node cannot resolve').toEqual([]);

    for (const s of mustFail) {
      expect(ok, `${s} still resolves — the exports map is publishing it again`).not.toContain(s);
      expect(bad.find(([b]) => b === s)?.[1]).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
  }, 30_000);
});

/**
 * Committed markdown assets must reach an npm consumer, and `tsc` will not carry them.
 *
 * `packages/core/dist` contains ZERO `.md` — the compiler copies only what it emits. So every
 * source directory holding committed markdown ships one of exactly two ways: a `files` entry naming
 * `src/<dir>` (core's three asset families), or a build step that mirrors it into `dist` (the
 * server's `skills`, 24 files). A new asset family added with neither would be present in the repo,
 * green in every test, and absent from the tarball — the resolver finds nothing only once it is
 * installed from the registry.
 *
 * A guard for `src/delivery-packagers` already existed, hand-written for that one family, in
 * `delivery-packager-assets.contract.test.ts`. Two of the three were unprotected. This derives the
 * roster from the filesystem instead, so the fourth family is covered before anyone thinks to.
 */
/**
 * `packages/core/README.md` documents the subpath table. It must match the manifest exactly.
 *
 * Caught in a release doc sweep: the README still listed `./providers/provider-factory`, a subpath
 * REMOVED earlier in this same audit because it published the `__setCoreTestProviderOverride*` hook
 * — so the README was advertising a door that had been deliberately closed. It also omitted
 * `./bounded-execution/cost-compute`, which had been declared all along. Both directions, both
 * wrong, and nothing could see it: the table is prose, and the manifest is data.
 */
describe('the core README subpath table matches the exports map', () => {
  const declared = Object.keys(
    (JSON.parse(readFileSync('packages/core/package.json', 'utf8')) as Pkg).exports ?? {},
  ).sort();
  const listed = [
    ...readFileSync('packages/core/README.md', 'utf8').matchAll(/^\| `(\.\/[a-z0-9/._-]+|\.)` \|/gm),
  ].map((m) => m[1]!).sort();

  it('finds both rosters', () => {
    // Floor: an unparsed table would make the comparison vacuous in both directions.
    expect(declared.length).toBeGreaterThan(10);
    expect(listed.length).toBeGreaterThan(10);
  });

  it('lists no subpath the manifest does not declare', () => {
    const stale = listed.filter((x) => !declared.includes(x));
    expect(stale, 'the README advertises subpath(s) that no longer exist').toEqual([]);
  });

  it('omits no subpath the manifest declares', () => {
    const missing = declared.filter((x) => !listed.includes(x));
    expect(missing, 'the README omits declared subpath(s) — consumers cannot discover them').toEqual([]);
  });
});

describe('every committed markdown asset root is shipped', () => {
  /** Top-level dirs under `<pkg>/src` that contain committed `.md`, and whether dist mirrors them. */
  function assetDirs(dir: string): { name: string; mirrored: boolean }[] {
    const src = join(dir, 'src');
    const names = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => hasMarkdown(join(src, n)));
    return names.map((name) => ({ name, mirrored: hasMarkdown(join(dir, 'dist', name)) }));
  }

  function hasMarkdown(root: string): boolean {
    if (!existsSync(root)) return false;
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .some((e) => e.isFile() && e.name.endsWith('.md'));
  }

  const ROWS = PACKAGES.flatMap((dir) =>
    assetDirs(dir).map((a) => ({ dir, ...a })),
  );

  it('finds asset directories in both packages', () => {
    // Floor: an empty roster passes every case below while checking nothing. Both packages have at
    // least one, and dist genuinely carries no core markdown — the premise the rule rests on.
    expect(ROWS.filter((r) => r.dir === 'packages/core').length).toBeGreaterThan(2);
    expect(ROWS.filter((r) => r.dir === 'packages/server').length).toBeGreaterThan(0);
    expect(hasMarkdown('packages/core/dist'), 'tsc now copies .md — this rule needs revisiting')
      .toBe(false);
  });

  it.each(ROWS.map((r) => [`${r.dir}/src/${r.name}`, r] as const))('%s reaches the tarball', (_l, r) => {
    const files = (JSON.parse(readFileSync(join(r.dir, 'package.json'), 'utf8')) as { files?: string[] }).files ?? [];
    const shipped = files.includes(`src/${r.name}`) || (r.mirrored && files.includes('dist'));
    expect(
      shipped,
      `${r.dir}/src/${r.name} holds committed .md but is neither listed in "files" nor mirrored into dist — it will be missing from the published package`,
    ).toBe(true);
  });
});
