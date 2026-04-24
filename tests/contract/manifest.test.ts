// Router framework inspected from packages/server/src/http/router.ts on 2026-04-24:
// - Framework used: custom node:http router (`Router` class)
// - Registered routes are held in `Router.routes`, a Map<method, Map<path, RouteEntry>>
// - Routes are enumerated via `router.listRoutes()` exposed through the test-only GET /__routes hook
import { describe, it, expect } from 'vitest';
import routesGolden from './goldens/routes.json' with { type: 'json' };
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

describe('contract: route manifest', () => {
  it('registers exactly the golden set of routes', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/__routes`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.ok).toBe(true);
      const actual = (await res.json()) as { method: string; path: string }[];
      const normalize = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
      expect(actual.map(normalize).sort()).toEqual([...routesGolden].sort());
    } finally {
      await h.close();
    }
  });
});
