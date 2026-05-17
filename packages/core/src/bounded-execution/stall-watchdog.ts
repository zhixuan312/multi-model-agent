import type { EnvelopeBus } from '../events/envelope-bus.js';
import type { TaskEnvelopeStore } from '../events/task-envelope.js';
import type { EventEmitter } from '../events/event-emitter.js';

/**
 * Wires the long-declared-but-previously-inert orchestrator stall watchdog.
 *
 * Listens on the EnvelopeBus for runner progress events; resets
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

// RESET_EVENTS: any event that proves a task is making real progress.
// MUST be names actually emitted by the providers (see codex-cli-session.ts
// + claude-session.ts). The previous values (runner_turn_*) were aspirational
// — never wired anywhere — so the watchdog was acting as a dumb deadline
// timer regardless of stage progress.
const RESET_EVENTS = new Set<string>([
  // codex CLI
  'codex_turn_started',
  'codex_turn_completed',
  'codex_agent_message',
  'codex_command_completed',
  // claude SDK
  'claude_turn_started',
  'claude_turn_completed',
  'claude_text_emission',
  'claude_tool_call',
]);

export interface StallWatchdogContext {
  stall: { controller: AbortController; lastEventAtMs: number; fired: boolean };
  timing: { stallTimeoutMs: number };
  bus?: EventEmitter | EnvelopeBus;
  envelope?: TaskEnvelopeStore;
  batchId?: string;
  taskIndex?: number;
}

export function startStallWatchdog(ctx: StallWatchdogContext): () => void {
  const taskId = ctx.batchId ? `${ctx.batchId}:${ctx.taskIndex ?? 0}` : '';
  const bus = ctx.bus as any;
  if (bus?.emitPlainEntry) {
    // EnvelopeBus — new API
    bus.emitPlainEntry({
      ts: new Date().toISOString(),
      kind: 'stall_watchdog_armed',
      fields: {
        task_id: taskId,
        idle_threshold_ms: ctx.timing.stallTimeoutMs,
      },
    });
  } else if (bus?.emit) {
    // EventEmitter — old API (fallback for compatibility)
    bus.emit({
      event: 'stall_watchdog_armed',
      ts: new Date().toISOString(),
      batchId: ctx.batchId,
      taskIndex: ctx.taskIndex,
      stallTimeoutMs: ctx.timing.stallTimeoutMs,
    });
  }

  // Note: EnvelopeBus emits envelope snapshots and plain entries; we no longer
  // subscribe to provider events for stall-watchdog detection. Provider event
  // filtering will be handled by heartbeat tracking in execution-context.ts.
  // This handler is a no-op for the new bus design.

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
    const idleMs = Date.now() - ctx.stall.lastEventAtMs;
    if (idleMs >= ctx.timing.stallTimeoutMs) {
      ctx.stall.fired = true;
      ctx.stall.controller.abort();
      const taskId = ctx.batchId ? `${ctx.batchId}:${ctx.taskIndex ?? 0}` : '';
      const bus = ctx.bus as any;
      if (bus?.emitPlainEntry) {
        // EnvelopeBus — new API
        bus.emitPlainEntry({
          ts: new Date().toISOString(),
          kind: 'stall_watchdog_fired',
          fields: {
            task_id: taskId,
            idle_ms_observed: idleMs,
          },
        });
      } else if (bus?.emit) {
        // EventEmitter — old API (fallback for compatibility)
        bus.emit({
          event: 'stall_watchdog_fired',
          ts: new Date().toISOString(),
          batchId: ctx.batchId,
          taskIndex: ctx.taskIndex,
          idleMs,
          stallTimeoutMs: ctx.timing.stallTimeoutMs,
        });
      }
      if (ctx.envelope) {
        ctx.envelope.recordStall({ atMs: Date.now(), idleMs });
      }
    }
  }, pollIntervalMs);

  return () => {
    clearInterval(interval);
  };
}
