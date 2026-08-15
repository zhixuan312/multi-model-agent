/**
 * The full-smoke harness is not part of `npm test`, so nothing noticed its constants going stale.
 *
 * `scripts/full-smoke/` runs against a live daemon via `npm run smoke:full`. It is the only thing
 * that exercises the telemetry wire end to end, and it carried
 * `export const SCHEMA_VERSION = 6; // packages/core/src/events/wire-schema.ts` — a literal
 * restated from a file it names, which has said `7` since the 6.10.0 telemetry work. The single
 * check that reads it therefore compared every event against a version the engine had stopped
 * emitting.
 *
 * It survived because of the second defect on the same line:
 *
 *     sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'FAIL'
 *
 * A missing `schemaVersion` PASSED. So the check excused precisely the failure it exists to catch —
 * an envelope reaching the queue with no version at all — and the comment eleven lines below it in
 * the same function already names that trap for a different field: "a check that never runs looks
 * exactly like a check that always passes."
 *
 * Both are fixed at the source (config.mjs re-exports from the defining module; a missing version
 * is a FAIL). This test exists because the harness runs on demand and the suite runs on every
 * commit — a value the suite cannot see is a value that drifts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../../packages/core/src/events/wire-schema.js';

const CONFIG = 'scripts/full-smoke/config.mjs';
const VERIFY = 'scripts/full-smoke/verify.mjs';

describe('the full-smoke harness derives its wire constants', () => {
  const config = readFileSync(CONFIG, 'utf8');

  it('SCHEMA_VERSION is re-exported, never restated as a literal', () => {
    expect(
      config,
      'config.mjs pins SCHEMA_VERSION to a literal again — it will drift from wire-schema.ts',
    ).not.toMatch(/export const SCHEMA_VERSION\s*=\s*\d/);
    expect(config).toMatch(/export \{ SCHEMA_VERSION \} from '.*wire-schema\.js'/);
  });

  it('the subpath it imports is one the package actually publishes', () => {
    // The re-export names `packages/core/dist/events/wire-schema.js` by relative path, so it does
    // not go through the `exports` map — but a future move to a bare specifier would, and the
    // module has to exist either way.
    const pkg = JSON.parse(
      readFileSync('packages/core/package.json', 'utf8'),
    ) as { exports?: Record<string, unknown> };
    expect(Object.keys(pkg.exports ?? {})).toContain('./events/wire-schema');
  });

  it('the value the harness would resolve is the current wire version', () => {
    // Floor: proves SCHEMA_VERSION is a real number here, so the assertions above are about a
    // constant that means something.
    expect(typeof SCHEMA_VERSION).toBe('number');
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('a missing schemaVersion fails the smoke check instead of passing it', () => {
    // Comment lines are stripped first. The fix's own comment QUOTES the removed expression in
    // order to explain it, and a naive text match flags that mention as if it were the code — a
    // ratchet that fires on the sentence describing its own repair. Measure use, not mention.
    const code = readFileSync(VERIFY, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    expect(
      code,
      'the `sv === undefined ||` escape is back — an envelope with no version would report PASS',
    ).not.toMatch(/sv === undefined \|\|/);
    expect(code).toMatch(/C\('schema-version', sv === SCHEMA_VERSION \? 'PASS' : 'FAIL'/);
  });
});
