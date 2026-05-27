// Bun-native fetch stubbing for research-adapter tests.
// Replaces undici MockAgent (Bun's undici shim has a non-functional MockAgent) now that
// the adapters use global fetch instead of undici.request.
import { mock } from 'bun:test';

let original: typeof globalThis.fetch | undefined;

/** Capture the real fetch so it can be restored after the test. Call in beforeEach. */
export function saveFetch(): void {
  if (!original) original = globalThis.fetch;
}

/** Restore the real fetch. Call in afterEach. */
export function restoreFetch(): void {
  if (original) globalThis.fetch = original;
}

/** Install a fetch stub. The handler receives (url, init) and returns a Response (or throws to simulate a network error). */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  ) as unknown as typeof globalThis.fetch;
}

/** Convenience: a JSON-ish Response with a status and raw body string. */
export function resp(status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Response {
  // 3xx/204 may legitimately carry a null body; Response allows status 200..599.
  return new Response(status === 204 || (status >= 300 && status < 400) ? null : body, { status, headers });
}
