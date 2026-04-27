import type { EventSink } from './bus.js';
import type { EventType } from './events.js';
import { CLOUD_EVENT_NAMES } from './events.js';

type CloudEventName = 'task.completed' | 'session.started' | 'install.changed' | 'skill.installed';

export interface Recorder {
  enqueue(event: Record<string, unknown>): void;
}

function isCloudEvent(e: EventType): e is EventType & { event: CloudEventName } {
  return CLOUD_EVENT_NAMES.has(e.event as CloudEventName);
}

export class TelemetrySink implements EventSink {
  readonly name = 'telemetry';

  constructor(private readonly recorder: Recorder | null) {}

  emit(event: EventType): void {
    if (!this.recorder) return;
    if (!isCloudEvent(event)) return;
    try {
      this.recorder.enqueue(event as Record<string, unknown>);
    } catch {
      // recorder enforces buffer cap; never throws to caller
    }
  }
}
