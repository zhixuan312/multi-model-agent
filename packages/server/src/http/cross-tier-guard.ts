import type { ServerResponse } from 'node:http';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { sendError } from './errors.js';

/**
 * Guards read-only routes against misconfigured cross-tier review topology.
 *
 * Read-only routes (audit, review, verify, investigate, debug) require both
 * 'standard' and 'complex' agent slots to be configured so the quality_only
 * review pipeline can run cross-tier comparison.
 *
 * Callers MUST check the read-only-review kill switch before calling this
 * function — if quality review is disabled for the route, the cross-tier
 * check is skipped entirely.
 */
export function assertCrossTierConfigured(
  config: MultiModelConfig,
  res: ServerResponse,
): boolean {
  // Cast to unknown — this is a runtime defense-in-depth guard; the Zod schema
  // already requires both slots, but a config constructed outside parseConfig
  // (e.g. in tests) may be missing one.
  const agents = (config as unknown as { agents?: Record<string, unknown> }).agents;

  if (!agents?.standard) {
    sendError(
      res,
      400,
      'invalid_configuration',
      "Read-only routes require both 'standard' and 'complex' slots configured for cross-tier review. " +
        "Configure the missing 'standard' slot or set MMAGENT_READ_ONLY_REVIEW=disabled to skip the review topology.",
    );
    return false;
  }

  if (!agents?.complex) {
    sendError(
      res,
      400,
      'invalid_configuration',
      "Read-only routes require both 'standard' and 'complex' slots configured for cross-tier review. " +
        "Configure the missing 'complex' slot or set MMAGENT_READ_ONLY_REVIEW=disabled to skip the review topology.",
    );
    return false;
  }

  return true;
}
