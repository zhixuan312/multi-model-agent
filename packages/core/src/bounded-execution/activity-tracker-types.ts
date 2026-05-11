import type { HeadlineSnapshot } from '../stores/batch-registry.js';

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
 * the final flush).  The server uses this — combined with the BatchRegistry entry
 * it already holds — to compose the running headline and push it via
 * `BatchRegistry.updateRunningHeadlineSnapshot`.
 *
 * ActivityTracker has no knowledge of BatchRegistry; it only emits this payload.
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
    filesRead: number;
    filesWritten: number;
    toolCalls: number;
  };
  costUSD: number | null;
  costDeltaVsMainUSD: number | null;
  /** Per-stage idle time (ms since last LLM/tool/text event in the current stage). */
  stageIdleMs: number;
  /**
   * Rich per-stage headline composed by ActivityTracker, e.g.
   *   "[1/5] Implementing (openai) — 45s, $0.12 saved (3.2x), 2 read, 3 written, 7 tool calls"
   * Callers (like the server's BatchRegistry) use this for single-task batches
   * so the 202 polling body carries the stage-detail view instead of a bare
   * "running, 47s elapsed" summary.
   */
  headline: string;
  /** Lightweight state snapshot for BatchRegistry.updateRunningHeadlineSnapshot. */
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
   * final one). Receives a snapshot of the timer's current state so the
   * caller can compose the running headline from the BatchRegistry entry.
   *
   * Core ActivityTracker has no knowledge of BatchRegistry — it only invokes
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
