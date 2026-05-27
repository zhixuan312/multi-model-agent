// packages/server/src/http/handlers/introspection/health.ts
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { DriftEntry, SkillManifestSync } from '../../../skill-install/skill-manifest-sync.js';

export type { DriftEntry } from '../../../skill-install/skill-manifest-sync.js';

export type HealthResponse =
  | { status: 'ok' }
  | { status: 'drift'; drift: DriftEntry[] };

/**
 * GET /health — unauthenticated liveness + skill manifest drift check.
 *
 * Minimal v4.0 shape (spec C13): status=ok when all installed skills match the
 * manifest; status=drift when one or more skills are missing, outdated, or orphaned.
 * No version/pid/uptimeMs — those live in telemetry and GET /status.
 */
export function buildHealthHandler(deps: { manifestSync: SkillManifestSync }): RawHandler {
  return () => {
    const drift: DriftEntry[] = deps.manifestSync.driftReport();
    const body: HealthResponse = drift.length === 0
      ? { status: 'ok' }
      : { status: 'drift', drift };
    return sendJson(200, body);
  };
}
