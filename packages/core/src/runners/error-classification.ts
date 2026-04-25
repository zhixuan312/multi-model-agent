import type { RunStatus } from './types.js';

/**
 * Classify a thrown error from a provider runner's request/stream path into
 * one of the finer-grained `RunStatus` variants introduced in Task 7.
 *
 * The function is deliberately:
 *   - Module-level and stateless (pure function of the error).
 *   - Tolerant of non-Error throws (strings, null, undefined, POJOs).
 *   - Conservative: anything unrecognised falls through to `'error'`.
 *
 * Classification order is significant. AbortError / "aborted" messages are
 * checked BEFORE network-error codes because a timeout-driven
 * `AbortController.abort()` path often surfaces an error whose message
 * mentions "aborted" and whose underlying cause may have `.code` set — we
 * want that to surface as `api_aborted`, not `network_error`.
 *
 * `api_error` is keyed off the presence of a numeric `.status` field, which
 * is the convention used by both `openai` SDK `APIError` and fetch-based
 * HTTP error wrappers in this codebase.
 *
 * NOTE: this helper does NOT replace the codex-runner's turn-scoped
 * `lastResponseStatus` disambiguation from Task 5. The `reason` returned
 * here is the *classification* string; the codex catch branch still builds
 * a richer `detailed` message and uses it as the final `error` field.
 */

/**
 * Detect whether an error represents a provider-side rate limit (HTTP 429
 * or equivalent). Used by every runner to surface a structured
 * `rate_limit_exceeded` code so the escalation orchestrator and downstream
 * observers can distinguish rate-limit backpressure from other API errors
 * without string-matching the `error` field.
 */
export function isRateLimit(err: unknown): boolean {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.status === 'number' && e.status === 429) return true;
  if (typeof e.code === 'string' && e.code === 'rate_limit_exceeded') return true;
  if (typeof e.message === 'string' && /rate.limit/i.test(e.message)) return true;
  return false;
}

export function classifyError(err: unknown): { status: RunStatus; reason: string } {
  // Unwrap the common fields we read below. `err` may be anything, so guard
  // every access.
  const e = (err ?? {}) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const code = typeof e.code === 'string' ? e.code : '';

  // 1. Abort: AbortError or any message containing "aborted".
  if (name === 'AbortError' || /aborted/i.test(message)) {
    return {
      status: 'api_aborted',
      reason: 'request was aborted (signal cancellation or provider-side abort)',
    };
  }

  // 2. Network-level failures: DNS/connection errors, or messages that
  //    explicitly mention "network".
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || /network/i.test(message)) {
    return {
      status: 'network_error',
      reason: message || 'network error',
    };
  }

  // 3. HTTP errors exposed via a numeric `.status` field.
  if (typeof e.status === 'number') {
    return {
      status: 'api_error',
      reason: `HTTP ${e.status}${message ? `: ${message}` : ''}`,
    };
  }

  // 4. Fallback: unknown error shape. Best-effort `reason` extraction.
  let reason: string;
  if (message) {
    reason = message;
  } else if (typeof err === 'string') {
    reason = err;
  } else {
    try {
      reason = String(err);
    } catch {
      reason = 'unknown error';
    }
  }
  return { status: 'error', reason };
}
