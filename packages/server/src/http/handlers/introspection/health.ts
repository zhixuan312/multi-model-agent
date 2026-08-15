// packages/server/src/http/handlers/introspection/health.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';

/** One unit of drift GET /health reports. `client` is a loose string (not
 *  `ClientId`) so a caller-injected `manifestSync` (tests) is never forced to
 *  import the canonical client vocabulary just to shape a fixture. */
export interface DriftEntry {
  skill: string;
  client: string;
  issue: 'missing' | 'outdated' | 'orphan' | 'failed';
}

/** The seam GET /health reads drift through -- production wires this to
 *  `inventory.ts` (see `http/server.ts`); tests inject a fixed report so the
 *  response never depends on what happens to be installed on the machine
 *  running the suite. */
export interface SkillManifestSync {
  driftReport(): DriftEntry[] | Promise<DriftEntry[]>;
}

type HealthResponse =
  | { status: 'ok' }
  | { status: 'drift'; drift: DriftEntry[] };

/**
 * GET /health — unauthenticated liveness + provisioning drift check.
 *
 * Minimal v4.0 shape (spec C13): status=ok when every declared client's
 * provisioning is healthy; status=drift when one or more clients are missing,
 * outdated, orphaned, or have an unresolved provisioning marker ('failed').
 * No version/pid/uptimeMs — those live in telemetry and GET /status.
 */
export function buildHealthHandler(deps: { manifestSync: SkillManifestSync }): RawHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    const drift: DriftEntry[] = await deps.manifestSync.driftReport();
    const body: HealthResponse = drift.length === 0
      ? { status: 'ok' }
      : { status: 'drift', drift };
    sendJson(res, 200, body);
  };
}
