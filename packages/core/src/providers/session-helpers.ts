import type { SessionOpts } from '../types/run-result.js';
import type { TaskEnvelopeStore } from '../events/task-envelope.js';

export interface BusLike { emitPlainEntry(entry: unknown): void }

export function busOf(opts: SessionOpts): BusLike | undefined {
  const b = opts.bus as { emitPlainEntry?: unknown } | undefined;
  return b && typeof b.emitPlainEntry === 'function' ? (b as BusLike) : undefined;
}

export function envelopeOf(opts: SessionOpts): TaskEnvelopeStore | undefined {
  const e = opts.envelope as { recordToolCall?: unknown } | undefined;
  return e && typeof e.recordToolCall === 'function' ? (e as TaskEnvelopeStore) : undefined;
}
