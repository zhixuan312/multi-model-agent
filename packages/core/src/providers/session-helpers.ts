import type { SessionOpts } from '../types/run-result.js';

export interface BusLike { emitPlainEntry(entry: unknown): void }

export function busOf(opts: SessionOpts): BusLike | undefined {
  const b = opts.bus as { emitPlainEntry?: unknown } | undefined;
  return b && typeof b.emitPlainEntry === 'function' ? (b as BusLike) : undefined;
}
