import type { EventSink } from './event-emitter.js';
import type { EventType } from './observability-events.js';
import type { JsonlWriter } from '../events/jsonl-writer.js';

export class LocalLogSink implements EventSink {
  readonly name = 'local-log';

  constructor(private readonly writer: JsonlWriter) {}

  emit(event: EventType): void {
    this.writer.writeLine(event as Record<string, unknown>);
  }
}
