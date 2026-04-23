// packages/server/src/http/handlers/introspection/health.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../router.js';

/**
 * GET /health — lightweight liveness probe.
 *
 * This is the only unauthenticated route. It intentionally returns only
 * `{ ok: true }` — no counters, no project data. Richer operator data
 * lives on GET /status.
 *
 * Loopback guard is applied by the server pipeline before the handler
 * is invoked (see LOOPBACK_ONLY_PATHS in server.ts).
 */
export function buildHealthHandler(): RawHandler {
  return (_req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { ok: true });
  };
}
