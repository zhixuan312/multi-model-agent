import { redactSecrets } from '../identity/secret-redactor.js';
import type { EventType } from './observability-events.js';
import { EventSchemas } from './observability-events.js';

export interface EventSink {
  readonly name: string;
  emit(event: EventType | Record<string, unknown>): void;
}

export type EventListener = (event: Record<string, unknown>) => void;

/**
 * Unified event emitter per spec C7. Two output modes:
 *  - listeners (functions registered via on()) — used by lifecycle handlers
 *    and tests for inline observation of emitted events.
 *  - sinks (named handlers registered via constructor or addSink) — used by
 *    production fan-out to caller-response, verbose-log, telemetry channels.
 *
 * Both fire on every emit. Secret redaction runs universally at emit;
 * per-channel privacy filtering (telemetry-only) lives inside the telemetry
 * sink — this preserves the spec C7 two-layer scrubbing rule.
 *
 * Schema validation fires in dev/test for events with registered schemas;
 * unknown event names (e.g. diagnostic cost_check, time_check, heartbeat_timer)
 * pass through without validation.
 */
export class EventEmitter {
  private listeners: EventListener[] = [];
  private sinks: EventSink[] = [];

  constructor(sinks: EventSink[] = []) {
    this.sinks = sinks;
  }

  on(l: EventListener): void {
    this.listeners.push(l);
  }

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  emit(event: EventType | Record<string, unknown>): void {
    const eventName = typeof (event as { event?: unknown }).event === 'string'
      ? (event as { event: string }).event
      : undefined;

    if (eventName && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')) {
      const schema = EventSchemas[eventName as keyof typeof EventSchemas];
      if (schema) {
        const result = schema.safeParse(event);
        if (!result.success) {
          throw new Error(
            `emit-time schema violation for ${eventName}: ${JSON.stringify(result.error.format())}`,
          );
        }
      }
    }

    const redacted = redactSecrets(event) as Record<string, unknown>;

    for (const l of this.listeners) {
      try { l(redacted); } catch { /* listeners must not crash callers */ }
    }
    for (const sink of this.sinks) {
      try { sink.emit(redacted as EventType); } catch { /* sinks must not crash callers */ }
    }
  }
}
