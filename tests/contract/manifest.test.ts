// Router framework inspected from packages/server/src/http/router.ts on 2026-04-24:
// - Framework used: custom node:http router (`Router` class)
// - Registered routes are held in `Router.routes`, a Map<method, Map<path, RouteEntry>>
// - Routes are enumerated via `router.listRoutes()` exposed through the test-only GET /__routes hook
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import routesGolden from './goldens/routes.json' with { type: 'json' };
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

describe('contract: route manifest', () => {
  it('registers exactly the golden set of routes', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/__routes`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${h.token}` },
      });
      expect(res.ok).toBe(true);
      const actual = (await res.json()) as { method: string; path: string }[];
      const normalize = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
      expect(actual.map(normalize).sort()).toEqual([...routesGolden].sort());
    } finally {
      await h.close();
    }
  });

  /**
   * The golden above lists `GET /__routes`, and that route only exists when
   * `MMA_TEST_INTROSPECTION=1` — which the harness sets (`fixtures/harness.ts:122`). So the golden
   * describes a route table production never has, and the mismatch is invisible: both sides of the
   * comparison are measured in the same non-default mode.
   *
   * What that costs is the guard itself. Delete the `if (process.env.MMA_TEST_INTROSPECTION === '1')`
   * around the registration in `http/server.ts` and every assertion above still passes — the route
   * would simply be unconditional, shipping a full route enumeration to anyone who can reach the
   * daemon. A contract test for the route table that cannot notice a route escaping into production
   * is checking the wrong half.
   *
   * Read from the source rather than by booting a second server without the flag: the flag is read
   * once at registration time inside `startServer`, and the harness sets it process-wide before any
   * boot, so a second boot in this process would see it too. Grepping the registration is what
   * distinguishes "guarded" from "guarded when convenient".
   */
  it('the test-only route is the ONLY one behind the introspection flag, and is behind it', () => {
    const server = readFileSync('packages/server/src/http/server.ts', 'utf8');

    // Floor: if the flag name ever changes, the rest of this asserts nothing.
    expect(server, 'the introspection flag is gone from server.ts')
      .toContain("process.env.MMA_TEST_INTROSPECTION === '1'");

    // The registration must sit INSIDE the guard block: take the text from the guard to the end of
    // its block and require the route to be declared there.
    const guardAt = server.indexOf("if (process.env.MMA_TEST_INTROSPECTION === '1') {");
    const block = server.slice(guardAt, server.indexOf('\n  }\n', guardAt));
    expect(block, '/__routes is registered outside the introspection guard — it would ship')
      .toContain("router.register('GET', '/__routes'");

    // And it is the only golden entry that is test-only: every other route must be registered
    // somewhere OUTSIDE that block.
    const outside = server.slice(0, guardAt) + server.slice(guardAt + block.length);
    for (const entry of routesGolden as string[]) {
      const [method, path] = entry.split(' ') as [string, string];
      if (path === '/__routes') continue;
      expect(
        outside.includes(`'${method}', '${path}'`),
        `${entry} is in the route golden but not registered outside the test-only guard`,
      ).toBe(true);
    }
  });
});
