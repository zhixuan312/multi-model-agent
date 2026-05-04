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
 * Detect whether an error represents a provider-side context-limit
 * violation. Pattern-matches known provider error signatures for
 * context-window exceeded conditions.
 *
 * Used by every runner to set errorCode='provider_context_limit' so the
 * escalation orchestrator and downstream observers can distinguish
 * context-limit failures from other API errors without string-matching
 * the error field.
 */
export function isProviderContextLimit(err: unknown): boolean {
  const e = (err ?? {}) as {
    message?: unknown;
    code?: unknown;
    error?: unknown;
    bodyText?: unknown;
    status?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : '';
  const code = typeof e.code === 'string' ? e.code : '';
  const error = typeof e.error === 'string' ? e.error : '';
  const bodyText = typeof e.bodyText === 'string' ? e.bodyText : '';

  // Also inspect nested error shapes (some SDKs wrap in error.code / error.message).
  const nestedError = (typeof e.error === 'object' && e.error !== null) ? e.error as Record<string, unknown> : null;
  const nestedCode = typeof nestedError?.code === 'string' ? nestedError.code : '';
  const nestedMessage = typeof nestedError?.message === 'string' ? nestedError.message : '';

  const combined = `${message} ${code} ${error} ${bodyText} ${nestedCode} ${nestedMessage}`;

  // Check structured code fields first — these are the most specific
  // provider signals (OpenAI-compatible APIs commonly use this code).
  if (code === 'context_length_exceeded' || nestedCode === 'context_length_exceeded') return true;

  // OpenAI-compatible signatures seen in APIError messages:
  //   - "context_length_exceeded"
  //   - "context length exceeded"
  //   - "This model's maximum context length is ..."
  //   - "Please reduce the length of the messages"
  if (/context[_ -]length[_ -]exceeded/i.test(combined)) return true;
  if (/maximum context length/i.test(combined)) return true;
  if (/reduce the length of the messages?/i.test(combined)) return true;

  // Anthropic / generic context-window signatures.
  if (/context window(?: is| size| exceeded| limit| too)/i.test(combined)) return true;

  return false;
}

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
  // Provider context-window failures are API-side rejections even when the
  // thrown shape lacks a numeric HTTP status. Check this before generic HTTP
  // handling so classifyError() participates in provider_context_limit
  // classification instead of leaving these as plain api_error/error.
  if (isProviderContextLimit(err)) {
    return {
      status: 'api_error',
      reason: 'provider_context_limit',
    };
  }

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
      status: 'provider_transport_failure',
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
