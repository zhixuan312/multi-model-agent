import type { Client } from './manifest.js';
import { clientHeaders, toHeaderClientName } from './headers.js';

/**
 * Phase 0 stub — Phase 2 swaps the body to call `recorder.recordSkillInstalled(...)`.
 * This indirection keeps install-writers from carrying a forward dependency on the
 * telemetry recorder before it exists.
 *
 * Already wires `clientHeaders` so that when the HTTP call is added in Phase 2,
 * the `X-MMA-Client` header is ready to be sent.
 */
export function notifySkillInstalled(_skillId: string, client: Client): void {
  // Compute headers now so Phase 2 only needs to add the HTTP call.
  // The return value is intentionally unused until Phase 2.
  void clientHeaders(toHeaderClientName(client));
}
