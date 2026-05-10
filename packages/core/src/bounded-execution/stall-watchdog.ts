import type { EventEmitter } from '../events/event-emitter.js';

/**
 * Wires the long-declared-but-previously-inert orchestrator stall watchdog.
 *
 * Listens on the EventEmitter for runner progress events; resets
 * `lastEventAtMs` on each one. A polling timer fires
 * `controller.abort()` when no resetting event has arrived for longer
 * than `stallTimeoutMs` — i.e. the runner is hung at the network layer
 * (transport stuck, connection alive but no streaming events).
 *
 * Without this, the only ceiling on a hung provider call is the per-call
 * `timeoutMs` (60 min default). With it, hangs surface within
 * `stallTimeoutMs` (20 min default) and the orchestrator can fall back
 * or fail-soft promptly.
 *
 * Returns a disposer; the orchestrator MUST call it in a finally{} block
 * so the timer is cleared on the success path too.
 */

const RESET_EVENTS = new Set<string>([
  'runner_turn_started',
  'runner_response_received',
  'runner_turn_completed',
]);

export interface StallWatchdogContext {
  stall: { controller: AbortController; lastEventAtMs: number; fired: boolean };
  timing: { stallTimeoutMs: number };
  bus?: EventEmitter;
}

export function startStallWatchdog(ctx: StallWatchdogContext): () => void {
  ctx.bus?.on((event) => {
    const eventName = typeof event.event === 'string' ? event.event : '';
    if (RESET_EVENTS.has(eventName)) {
      ctx.stall.lastEventAtMs = Date.now();
    }
  });

  // Poll interval: fine enough to fire promptly, coarse enough to avoid
  // burning CPU on idle batches. Clamped to [1s, 5s].
  const pollIntervalMs = Math.min(
    5_000,
    Math.max(1_000, Math.floor(ctx.timing.stallTimeoutMs / 60)),
  );

  const interval = setInterval(() => {
    if (ctx.stall.fired) return;
    if (ctx.stall.controller.signal.aborted) {
      ctx.stall.fired = true;
      return;
    }
    if (Date.now() - ctx.stall.lastEventAtMs >= ctx.timing.stallTimeoutMs) {
      ctx.stall.fired = true;
      ctx.stall.controller.abort();
    }
  }, pollIntervalMs);

  return () => {
    clearInterval(interval);
    // EventEmitter has no off() in v4. The captured `ctx` becomes garbage
    // after the orchestrator returns and the listener is no longer
    // reachable in a way that matters. Adding off() is a follow-up if
    // listener accumulation shows up in profiling.
  };
}
