import type { Client } from './manifest.js';
import { clientHeaders, toHeaderClientName } from './headers.js';

export interface NotifySkillInstalledOpts {
  skillId: string;
  client: Client;
  /**
   * Override `fetch` for testing. When provided, the function POSTs to
   * the telemetry endpoint with X-MMA-Client header and verifies the
   * plumbing end-to-end. In production (Phase 0) this is omitted and
   * the function is a no-op. Phase 2 replaces the body with a real
   * recorder call.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Phase 0 stub — Phase 2 swaps the body to call `recorder.recordSkillInstalled(...)`.
 *
 * When `opts.fetch` is provided (tests only), performs a POST to verify header
 * plumbing end-to-end. The response is not awaited in production.
 */
export function notifySkillInstalled(opts: NotifySkillInstalledOpts): void {
  const headerName = toHeaderClientName(opts.client);
  const headers = { ...clientHeaders(headerName), 'content-type': 'application/json' };

  if (opts.fetch) {
    // Test path: fire a POST so the caller can capture X-MMA-Client.
    // Phase 2 replaces the entire body.
    opts.fetch('http://localhost:7337/v1/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'skill_installed', skillId: opts.skillId }),
    }).catch(() => { /* fire-and-forget */ });
  }
  // Production (Phase 0): no-op. Phase 2 adds recorder.recordSkillInstalled(...).
}
