// packages/server/src/http/handlers/introspection/health.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../router.js';
import type { SkillManifestSync } from '../../../install/skill-manifest-sync.js';

export interface HealthHandlerDeps {
  version: string;
  serverStartedAt: number;
  skillManifestSync?: SkillManifestSync;
}

/**
 * GET /health — unauthenticated liveness + minimal identity.
 *
 * Returns ok + version + pid + startedAt + uptimeMs + drift so `mmagent info` and
 * external monitoring can verify both reachability and the running instance.
 * When skillManifestSync is provided, drift reports installed-skill discrepancies.
 * Richer operator data (queue depth, active batches) lives on GET /status.
 */
export function buildHealthHandler(deps: HealthHandlerDeps): RawHandler {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now();
    const drift = deps.skillManifestSync?.driftReport() ?? [];
    sendJson(res, 200, {
      ok: true,
      version: deps.version,
      pid: process.pid,
      startedAt: deps.serverStartedAt,
      uptimeMs: now - deps.serverStartedAt,
      drift,
    });
  };
}
