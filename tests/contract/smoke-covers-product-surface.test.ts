/**
 * The release gate's coverage claim, checked against the product surface it claims to cover.
 *
 * `scripts/full-smoke/config.mjs` opens with "Comprehensive product release gate. Every scenario
 * tests a DISTINCT product capability" and "ALL 12 task types … + the context-blocks control op —
 * every dispatchable route is exercised." Nothing verified any of that: the harness runs on demand,
 * its scenario list is hand-maintained, and the surfaces it covers grow in files it never imports.
 *
 * Measured when this was written:
 *
 *   task types            12 / 12   ✓ the claim holds
 *   MCP tools              7 / 7    ✓
 *   HTTP routes           10 / 11   ✗ `POST /configure-provider` was never exercised
 *   Initiative operations 23 / 71   ✗ 32% — the newest and largest part of the product
 *
 * So the sentence "every dispatchable route is exercised" was false, and the Initiative Record
 * surface — which `record-surface.mjs` exists specifically to cover — was at a third.
 *
 * The first three are hard equalities: a new task type, route, or MCP tool must arrive with smoke
 * coverage. The fourth is a RATCHET rather than an equality, because closing 48 operations is a
 * body of work, not a commit — but it can only ever go up, and the uncovered names are printed on
 * failure so the next increment is obvious rather than a research task.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_TYPES } from '../../packages/core/src/unified/type-registry.js';
import routesGolden from './goldens/routes.json' with { type: 'json' };

const SMOKE = 'scripts/full-smoke';

/** Every .mjs in the harness, as one corpus — coverage may live in any module. */
const smokeText = readdirSync(SMOKE)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => readFileSync(join(SMOKE, f), 'utf8'))
  .join('\n');

const configText = readFileSync(join(SMOKE, 'config.mjs'), 'utf8');

describe('the smoke harness covers every task type', () => {
  it('finds the scenario table', () => {
    // Floor: if SCENARIOS stops being parseable here, every case below passes on an empty corpus.
    expect(configText).toMatch(/export const SCENARIOS = \[/);
    expect(TASK_TYPES.length).toBeGreaterThan(10);
  });

  it.each([...TASK_TYPES])('%s has a scenario', (type) => {
    expect(
      new RegExp(`type: '${type}'`).test(configText),
      `no full-smoke scenario dispatches type '${type}' — the release gate would not exercise it`,
    ).toBe(true);
  });
});

describe('the smoke harness exercises every HTTP route', () => {
  /** `GET /__routes` exists only under MMA_TEST_INTROSPECTION and is not a product route. */
  const PRODUCT_ROUTES = (routesGolden as string[]).filter((r) => !r.includes('/__routes'));

  it('finds routes to check', () => {
    expect(PRODUCT_ROUTES.length).toBeGreaterThan(8);
  });

  it.each(PRODUCT_ROUTES)('%s', (route) => {
    const path = route.split(' ')[1]!.replace(/\/:.*$/, '');
    expect(
      smokeText.includes(path),
      `${route} is a product route that no full-smoke module mentions — the gate claims "every `
      + `dispatchable route is exercised"`,
    ).toBe(true);
  });
});

describe('the smoke harness exercises every MCP tool', () => {
  const TOOLS = [
    ...readFileSync('packages/server/src/mcp/tool-surface.ts', 'utf8').matchAll(/^\s+name: '(mma_\w+)',$/gm),
  ].map((m) => m[1]!);

  it('finds tools to check', () => {
    expect(TOOLS.length).toBeGreaterThan(5);
  });

  it.each(TOOLS)('%s', (tool) => {
    expect(smokeText.includes(tool), `${tool} is exposed over MCP but no smoke module calls it`)
      .toBe(true);
  });
});

/**
 * A ratchet, not an equality. 23 of 71 when written; the bound is the measured number, so any
 * regression fails and any improvement is free. Raise it as coverage is added.
 */
describe('Initiative Record operation coverage does not regress', () => {
  const OPERATIONS = [
    ...new Set(
      [
        ...readFileSync('packages/core/src/initiative-record/schemas.ts', 'utf8')
          .matchAll(/\b(?:mutating|readOnly)\('([a-z_]+)'/g),
      ].map((m) => m[1]!),
    ),
  ].sort();

  const COVERED_FLOOR = 23;

  it('the operation surface is discoverable', () => {
    // Floor: a parse failure here would make the ratchet below trivially satisfiable.
    expect(OPERATIONS.length).toBeGreaterThan(60);
  });

  it(`at least ${COVERED_FLOOR} of ${71} operations are exercised`, () => {
    const covered = OPERATIONS.filter((op) => smokeText.includes(op));
    const uncovered = OPERATIONS.filter((op) => !smokeText.includes(op));
    expect(
      covered.length,
      `Initiative operation coverage FELL to ${covered.length}/${OPERATIONS.length}. `
      + `Uncovered:\n  ${uncovered.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(COVERED_FLOOR);
  });
});
