import type { SessionOpts } from '../types/run-result.js';

export interface BusLike { emitPlainEntry(entry: unknown): void }

export function busOf(opts: SessionOpts): BusLike | undefined {
  const b = opts.bus as { emitPlainEntry?: unknown } | undefined;
  return b && typeof b.emitPlainEntry === 'function' ? (b as BusLike) : undefined;
}

/**
 * How long a turn's wall-clock guard should wait before firing, or `null` when the budget is
 * genuinely unbounded and no guard should be armed.
 *
 * Both runners computed this inline, identically, and so shared one bug: they floored the
 * remaining time at 0 and then armed the timer only for `> 0`, which made an ELAPSED deadline
 * take the same path as "no deadline configured" and left the turn running unbounded. That is
 * reachable — `runTwoPhasePipeline` computes ONE deadline for the whole run and gives it to
 * both sessions, so an implementer that spends the entire budget hands the reviewer an elapsed
 * one, and the reviewer becomes the only unbounded stage of an already-late run.
 *
 * `0` and `null` are the distinction the inline version collapsed: 0 means "no time left, stop
 * now", null means "no limit was set". Only a non-finite deadline yields null.
 */
export function wallClockDelayMs(deadline: number, now: number = Date.now()): number | null {
  const remaining = deadline - now;
  return Number.isFinite(remaining) ? Math.max(0, remaining) : null;
}
