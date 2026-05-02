import type { EventType } from './events.js';
import { EventSchemas } from './events.js';

export interface EventSink {
  readonly name: string;
  emit(event: EventType): void;
}

export class EventBus {
  private readonly sinks: EventSink[];

  constructor(sinks: EventSink[]) {
    this.sinks = sinks;
  }

  emit(event: EventType): void {
    // Emit-time schema validation in dev/test (§3.11).
    // Validates the full persisted envelope (including the `event`
    // discriminator field), so one schema is authoritative for both
    // emit and ingest.
    //
    // Unknown event names (no entry in EventSchemas) pass through
    // without validation. This is intentional: production code emits
    // non-schema diagnostic events (cost_check, time_check,
    // heartbeat_timer, task_done_summary) that are consumed by verbose
    // logging and JSONL sinks but don't need schema enforcement.
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      const schema = EventSchemas[event.event];
      if (schema) {
        const result = schema.safeParse(event);
        if (!result.success) {
          throw new Error(
            `emit-time schema violation for ${event.event}: ${JSON.stringify(result.error.format())}`,
          );
        }
      }
    }

    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // sinks must not crash callers
      }
    }
  }
}
