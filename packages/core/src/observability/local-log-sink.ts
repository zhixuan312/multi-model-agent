import type { EventSink } from './bus.js';
import type { EventType } from './events.js';
import type { JsonlWriter } from '../diagnostics/jsonl-writer.js';

export class LocalLogSink implements EventSink {
  readonly name = 'local-log';

  constructor(private readonly writer: JsonlWriter) {}

  emit(event: EventType): void {
    this.writer.writeLine(event as Record<string, unknown>);
  }
}
