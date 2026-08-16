/**
 * Everything an error carries, flattened — for assertions that a secret did NOT escape.
 *
 * `String(err)` is `"Error: <message>"` and nothing else: no `cause`, no own properties, no
 * stack. Credentials travel in request headers and undici attaches request detail to `cause`, so
 * the likeliest way a key or an email actually leaks is the one shape `String()` cannot see. Three
 * separate leak tests (Brave keys, Crossref mailto, OpenAlex mailto) each inspected only the
 * message, which made them pass for the wrong reason.
 *
 * Use with `await expect(fn()).rejects.toThrow()` first, or capture the error from a `catch` whose
 * surrounding test also asserts that it threw — an assertion that only runs inside `catch` is
 * silently skipped when the call succeeds, which is exactly the case a leak test must not miss.
 */
export function fullyRendered(err: unknown, depth = 0): string {
  if (depth > 5 || err === null || err === undefined) return String(err);
  const parts = [String(err)];
  if (err instanceof Error) {
    if (err.stack) parts.push(err.stack);
    for (const key of Object.getOwnPropertyNames(err)) {
      const value = (err as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string' || typeof value === 'number') parts.push(`${key}=${value}`);
    }
    if (err.cause !== undefined) parts.push(fullyRendered(err.cause, depth + 1));
  } else if (typeof err === 'object') {
    try { parts.push(JSON.stringify(err)); } catch { /* circular — the pieces above still apply */ }
  }
  return parts.join('\n');
}
