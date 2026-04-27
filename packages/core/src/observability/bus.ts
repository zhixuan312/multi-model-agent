import type { EventType } from './events.js';

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
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // sinks must not crash callers
      }
    }
  }
}
