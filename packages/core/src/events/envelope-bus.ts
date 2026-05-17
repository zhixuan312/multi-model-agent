// packages/core/src/events/envelope-bus.ts
import type { TaskEnvelope } from './task-envelope.js';
import type { PlainLogEntry } from './plain-log-entry.js';

export type BusMessage =
  | { type: 'envelope'; envelope: TaskEnvelope; reason: string }
  | { type: 'plain'; entry: PlainLogEntry };

export interface Subscriber {
  readonly name: string;
  receive(msg: BusMessage): void;
}

export class EnvelopeBus {
  private subs: Subscriber[] = [];

  subscribe(s: Subscriber): () => void {
    this.subs.push(s);
    return () => this.unsubscribe(s);
  }

  unsubscribe(s: Subscriber): void {
    const i = this.subs.indexOf(s);
    if (i !== -1) this.subs.splice(i, 1);
  }

  emitEnvelopeSnapshot(envelope: TaskEnvelope, reason: string): void {
    const msg: BusMessage = { type: 'envelope', envelope, reason };
    for (const s of this.subs) {
      try { s.receive(msg); } catch (err) {
        process.stderr.write(`[mmagent] bus_subscriber_error sub=${s.name} reason=${reason} err=${(err as Error).message}\n`);
      }
    }
  }

  emitPlainEntry(entry: PlainLogEntry): void {
    const msg: BusMessage = { type: 'plain', entry };
    for (const s of this.subs) {
      try { s.receive(msg); } catch (err) {
        process.stderr.write(`[mmagent] bus_subscriber_error sub=${s.name} kind=${entry.kind} err=${(err as Error).message}\n`);
      }
    }
  }
}
