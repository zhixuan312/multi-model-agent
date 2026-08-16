import { describe, it, expect } from 'vitest';
import { startTestServer } from '../helpers/test-server.js';

/**
 * The canary: the server starts on an ephemeral port and its router dispatches.
 *
 * This was two cases over two boots, and neither said what its name claimed. The first duplicated
 * `handlers/introspection/health.test.ts`, which asserts the exact `{ status: 'ok' }` body rather
 * than one field of it. The second was titled "router dispatches path params correctly" and
 * fetched an unknown path expecting 404 — exercising no path parameter at all, and duplicating
 * `processing-order.test.ts`'s `not_found` case besides.
 *
 * One boot now, and the param assertion is real: `/execution/<id>` must reach the parameterised
 * route while `/execution` reaches the bare one, which is the distinction a prefix match would
 * collapse.
 */
describe('server smoke test', () => {
  it('starts, serves /health, and routes bare vs parameterised paths distinctly', async () => {
    const s = await startTestServer();
    try {
      expect((await fetch(`${s.url}/health`)).status).toBe(200);

      // No agents are configured in the test server, so every `/execution` route resolves to the
      // `no_agent_config` branch. That is the point: a 503 from `/execution/<id>` proves the
      // PARAMETERISED route matched — an unmatched path would 404 long before any handler ran.
      const withParam = await fetch(`${s.url}/execution/some-execution-id`, {
        headers: { Authorization: `Bearer ${s.token}`, 'X-MMA-Client': 'claude-code' },
      });
      expect(withParam.status).toBe(503);
      expect((await withParam.json()).error.code).toBe('no_agent_config');

      // The bare path is a DIFFERENT route (POST only), so GET it is a method mismatch rather
      // than a parameter — proving the router did not treat `/execution` as `/execution/:id`.
      const bare = await fetch(`${s.url}/execution`, {
        headers: { Authorization: `Bearer ${s.token}`, 'X-MMA-Client': 'claude-code' },
      });
      expect(bare.status).toBe(405);
      expect(bare.headers.get('allow')).toBe('POST');

      // …and a path matching neither is still a 404.
      expect((await fetch(`${s.url}/not-a-real-endpoint`)).status).toBe(404);
    } finally {
      await s.stop();
    }
  });
});
