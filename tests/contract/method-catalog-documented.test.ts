/**
 * The README's Method catalog must name every registered Method.
 *
 * It listed nine — software change, research, solution design, architecture review, workflow design,
 * source validation, risk analysis, technical writing, regulatory assessment — which was the
 * complete set at migration v5. Migration v6 seeds a tenth, `intent-to-initiative@1`, deliberately
 * "kept separate from BUILTIN_METHODS so the nine version-5 declarations are never touched"
 * (migrations.ts). Adding one that way is right for the data, and it is exactly the shape that
 * leaves a hand-written list behind: nobody editing the v6 block has a reason to open the README.
 *
 * `method` is caller-settable on every task type and an unregistered identifier is a synchronous
 * HTTP 400 `unknown_method`, so the catalog is not decoration — it is how a caller learns which
 * identifiers exist. One missing from the list is one nobody sends.
 *
 * Derived from the committed guidance assets in `packages/core/src/methods/`, which
 * `assertGuidanceAssetBijection` already holds in exact correspondence with the registry's
 * identifier list — so scanning them needs no production constant exported for a test's benefit. An
 * eleventh method fails here until it is documented.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// Whitespace-collapsed: the catalog is a prose list that hard-wraps, so a two-word name can be
// split across lines ("source\nvalidation") and a literal substring search would miss it.
const README = readFileSync('README.md', 'utf8').replace(/\s+/g, ' ');

/** One directory per registered Method, each holding the committed `guidance.md`. */
const METHOD_NAMES = readdirSync('packages/core/src/methods', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** `software-change` → `software change`, the prose form the catalog is written in. */
function proseName(name: string): string {
  return name.replace(/-/g, ' ');
}

describe('every registered Method appears in the README catalog', () => {
  it('the roster is non-empty and every entry carries its guidance asset', () => {
    // Floor: an empty scan would make every case below vacuous, and a directory with no
    // guidance.md is not a Method the engine can actually load.
    expect(METHOD_NAMES.length).toBeGreaterThan(5);
    for (const name of METHOD_NAMES) {
      expect(
        readFileSync(`packages/core/src/methods/${name}/guidance.md`, 'utf8').length,
      ).toBeGreaterThan(0);
    }
  });

  it.each(METHOD_NAMES)('%s is documented', (name) => {
    expect(
      README.includes(proseName(name)),
      `the README Method catalog does not name ${name} ("${proseName(name)}")`,
    ).toBe(true);
  });

  /**
   * `execution-runtime.test.ts` proves a no-Method dispatch injects no guidance by asserting the
   * marker `/^# .+ — Method guidance$/m` appears in NEITHER prompt. That assertion is only as good
   * as the convention it keys on: a future asset opening with any other heading would be injectable
   * without failing anything, and the absence check would quietly stop covering it — an absence
   * assertion that decays is worse than none, because it still reads as protection.
   *
   * All ten match today. Pinned here so the eleventh must too.
   */
  it.each(METHOD_NAMES)('%s guidance opens with the marker heading the absence check keys on', (name) => {
    const first = readFileSync(`packages/core/src/methods/${name}/guidance.md`, 'utf8').split('\n')[0];
    expect(first, 'execution-runtime.test.ts greps for this exact heading shape')
      .toMatch(/^# .+ — Method guidance$/);
  });
});

/**
 * The same drift, one section further down, and worse: the README's MCP section named
 * `mma_task_get`, `mma_task_wait`, `mma_task_list` and `mma_task_cancel`. Those tools do not exist
 * — the surface exposes `mma_execution_*` — so a reader following the README got "unknown tool"
 * from the server. It also documented the handle as `{ taskId, type, cwd }` when every tool's
 * schema says `executionId` (`taskId` is a real but unrelated provider-level event tag).
 *
 * The count ("Seven tools") was right the whole time, which is how the names survived: anyone
 * checking the claim by counting found it correct.
 *
 * Both directions are checked. A tool the README omits is undiscoverable; a name it invents is
 * worse, because it looks like an instruction and fails at the point of use.
 */
describe('the README names the MCP tools that exist', () => {
  const surface = readFileSync('packages/server/src/mcp/tool-surface.ts', 'utf8');
  const TOOL_NAMES = [...surface.matchAll(/^\s+name: '(mma_\w+)',$/gm)].map((m) => m[1]!);

  it('finds the tool surface', () => {
    expect(TOOL_NAMES.length, 'no tool names parsed — the cases below would be vacuous')
      .toBeGreaterThan(5);
  });

  it.each(TOOL_NAMES)('%s appears in the README', (tool) => {
    expect(README.includes(tool), `the README never mentions the ${tool} tool`).toBe(true);
  });

  it('mentions no mma_ tool that the surface does not expose', () => {
    const mentioned = new Set([...README.matchAll(/`(mma_\w+)`/g)].map((m) => m[1]!));
    const invented = [...mentioned].filter((n) => !TOOL_NAMES.includes(n));
    expect(invented, 'the README documents tools that do not exist').toEqual([]);
  });

  it('documents the handle field the tool schemas actually require', () => {
    expect(README).toContain('{ executionId, type, cwd }');
    expect(surface).toMatch(/required: \['executionId'\]/);
  });
});
