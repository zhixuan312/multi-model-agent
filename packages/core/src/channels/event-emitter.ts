import { redactSecrets } from './secret-redactor.js';

export type EventListener = (event: Record<string, unknown>) => void;

export class EventEmitter {
  private listeners: EventListener[] = [];
  on(l: EventListener): void { this.listeners.push(l); }
  emit(event: Record<string, unknown>): void {
    const redacted = redactSecrets(event) as Record<string, unknown>;
    for (const l of this.listeners) l(redacted);
  }
}
