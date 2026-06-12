/**
 * Lightweight headline state snapshot for running-task progress display.
 * Previously defined in batch-registry.ts; inlined here after batch system removal.
 */
export interface HeadlineSnapshot {
  /** Static prefix of the headline up to but not including the live elapsed slot. */
  prefix: string;
  /** Stats clause to append after live elapsed, or empty string when no counter
   *  has fired yet. */
  statsClause: string;
  /** ms since epoch — used to compute live elapsed at request time. */
  dispatchedAt: number;
  /** Optional fallback headline string for queue / pre-dispatch phases. */
  fallback: string;
  /** Structured fields for aggregation. */
  stageLabel?: string;
  tier?: string;
  stageDone?: number;
  stageTotal?: number;
  toolWrites?: number;
  toolTotal?: number;
}

export function formatElapsed(ms: number): string {
  const rounded = Math.round(ms / 1000);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}m ${seconds}s`;
}

export type HeartbeatStage =
  | 'implementing' | 'review' | 'rework' | 'annotating' | 'committing' | 'terminal';

export const STAGE_LABELS: Record<HeartbeatStage, string> = {
  implementing: 'Implementing',
  review:       'Review',
  rework:       'Rework',
  annotating:   'Annotating',
  committing:   'Committing',
  terminal:     'Done',
};

export const REVIEW_STAGES: ReadonlySet<HeartbeatStage> = new Set(['review']);

/**
 * Lightweight state snapshot passed to `recordHeartbeat` on every tick (including
 * the final flush).  The server uses this to compose the running headline.
 *
 * ActivityTracker has no knowledge of any registry; it only emits this payload.
 */
export interface HeartbeatTickInfo {
  batchId: string;
  elapsedMs: number;
  idleSinceLlmMs: number;
  idleSinceToolMs: number;
  idleSinceTextMs: number;
  stage: HeartbeatStage;
  stageIndex: number;
  stageCount: number;
  reviewRound?: number;
  attemptCap?: number;
  provider: string;
  progress: {
    filesWritten: number;
  };
  costUSD: number | null;
  costDeltaVsMainUSD: number | null;
  /** Per-stage idle time (ms since last LLM/tool/text event in the current stage). */
  stageIdleMs: number;
  /**
   * Rich per-stage headline composed by ActivityTracker, e.g.
   *   "[1/5] Implementing (openai) — 45s, $0.12 saved (3.2x), 2 read, 3 written, 7 tool calls"
   */
  headline: string;
  /** Lightweight state snapshot for progress display. */
  snapshot: HeadlineSnapshot;
  /** Populated only on the tick immediately following a stage change. */
  phaseChange?: { from: HeartbeatStage; to: HeartbeatStage };
}

export interface ActivityTrackerOptions {
  provider: string;
  mainModel?: string;
  intervalMs?: number;
  /**
   * Optional callback invoked on every ActivityTracker tick (including the
   * final one). Receives a snapshot of the timer's current state.
   *
   * Core ActivityTracker has no knowledge of any registry — it only invokes
   * this callback if provided.
   */
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  /** The batchId this timer belongs to. Required when recordHeartbeat is set. */
  batchId?: string;
}

export interface TransitionFields {
  stage?: HeartbeatStage;
  stageIndex?: number;
  stageCount?: number;
  reviewRound?: number;
  attemptCap?: number;
  provider?: string;
  costUSD?: number | null;
  costDeltaVsMainUSD?: number | null;
}
