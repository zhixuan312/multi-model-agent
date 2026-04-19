import type { ProgressEvent } from './types.js';

function formatElapsed(ms: number): string {
  const rounded = Math.round(ms / 1000);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}m ${seconds}s`;
}

// ── HeartbeatStage ────────────────────────────────────────────────────────────

export type HeartbeatStage =
  | 'intaking'
  | 'implementing'
  | 'validating'
  | 'reviewing'
  | 'completed'
  | 'blocked'
  | 'needs_context';

const STAGE_LABELS: Record<HeartbeatStage, string> = {
  intaking: 'Intaking',
  implementing: 'Implementing',
  validating: 'Validating',
  reviewing: 'Reviewing',
  completed: 'Completed',
  blocked: 'Blocked',
  needs_context: 'Needs context',
};

// ── HeartbeatPayload ─────────────────────────────────────────────────────────

/** Shape emitted on every heartbeat interval tick. */
export interface HeartbeatPayload {
  stage: HeartbeatStage
  progress: number // 0–100
  headline: string
  elapsed: string
  /** Number of tool-call rounds completed so far. */
  turnsCompleted: number
}

// ── StallDetector ────────────────────────────────────────────────────────────

/** Number of consecutive unchanged-turns heartbeats before emitting a stall warning. */
export const STALL_HEARTBEAT_THRESHOLD = 5;

export type OnStallWarning = (stallCount: number) => void;

/**
 * Tracks consecutive heartbeats with no turns completed and emits a warning
 * when the threshold is crossed.
 */
export class StallDetector {
  private prevToolCalls = 0;
  private stallCount = 0;

  constructor(
    private readonly threshold: number,
    private readonly onStallWarning: OnStallWarning,
  ) {}

  /** Call once per heartbeat tick, after progress has been updated.
   *  `inFlight` should be true when a tool call is currently executing —
   *  stall detection is suppressed during those periods. */
  check(toolCalls: number, inFlight: boolean): void {
    if (!inFlight) {
      if (toolCalls === this.prevToolCalls) {
        this.stallCount++;
        if (this.stallCount >= this.threshold) {
          this.onStallWarning(this.stallCount);
          this.stallCount = 0; // reset after firing so we can detect future stalls
        }
      } else {
        this.stallCount = 0;
        this.prevToolCalls = toolCalls;
      }
    }
  }

  reset(): void {
    this.stallCount = 0;
    this.prevToolCalls = 0;
  }
}

// ── HeartbeatTimer ───────────────────────────────────────────────────────────

export interface HeartbeatTimerOptions {
  /** Heartbeat interval in milliseconds. Default: 5000. */
  intervalMs?: number
  /** Optional callback invoked when stall detection fires. */
  onStallWarning?: OnStallWarning
}

/**
 * Drives the `heartbeat` variant of `ProgressEvent` on a regular interval.
 * Callers configure it once via the constructor, then drive state through
 * `setStage`, `incrementTurns`, and `reportProgress`.
 */
export class HeartbeatTimer {
  private readonly intervalMs: number;
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly stallDetector: StallDetector;

  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  // Lifecycle position
  private stage: HeartbeatStage = 'intaking';
  private stageIndex = 1;
  private stageCount = 1;
  private reviewRound: number | undefined;
  private maxReviewRounds: number | undefined;

  // Progress counters
  private filesRead = 0;
  private filesWritten = 0;
  private turnsCompleted = 0;
  private progressPct = 0;

  // In-flight guard (stall detection suppressed while true)
  private inFlight = false;

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: HeartbeatTimerOptions = {},
  ) {
    this.onProgress = onProgress;
    this.intervalMs = options.intervalMs ?? 5000;
    this.stallDetector = new StallDetector(
      STALL_HEARTBEAT_THRESHOLD,
      options.onStallWarning ?? (() => {}),
    );
  }

  /** Begin emitting heartbeats. Resets all counters and sets stage to 'intaking'. */
  start(stageCount: number): void {
    this.stop();
    this.startTime = Date.now();
    this.stage = 'intaking';
    this.stageIndex = 1;
    this.stageCount = stageCount;
    this.reviewRound = undefined;
    this.maxReviewRounds = undefined;
    this.filesRead = 0;
    this.filesWritten = 0;
    this.turnsCompleted = 0;
    this.progressPct = 0;
    this.inFlight = false;
    this.stallDetector.reset();
    this.timer = setInterval(() => this.emit(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Advance to a new stage. Resets the stall detector so the threshold
   *  restarts from scratch in the new stage. */
  setStage(stage: HeartbeatStage, stageIndex: number, reviewRound?: number, maxReviewRounds?: number): void {
    this.stage = stage;
    this.stageIndex = stageIndex;
    this.reviewRound = reviewRound;
    this.maxReviewRounds = maxReviewRounds;
    this.stallDetector.reset();
  }

  /** Update stageCount when it is determined after the heartbeat has started. */
  updateStageCount(stageCount: number): void {
    this.stageCount = stageCount;
  }

  /** Set progress counters. Call whenever the worker's scratchpad updates. */
  reportProgress(filesRead: number, filesWritten: number, progress: number): void {
    this.filesRead = filesRead;
    this.filesWritten = filesWritten;
    this.progressPct = progress;
  }

  /** Increment the turn counter. Call once per completed tool-call round. */
  incrementTurns(): void {
    this.turnsCompleted++;
  }

  setInFlight(inFlight: boolean): void {
    this.inFlight = inFlight;
  }

  private emit(): void {
    // Run stall detection
    this.stallDetector.check(this.turnsCompleted, this.inFlight);

    const elapsed = formatElapsed(Date.now() - this.startTime);
    const headline = this.composeHeadline(elapsed);

    this.onProgress({
      kind: 'heartbeat',
      elapsed,
      stage: this.stage,
      progress: this.progressPct,
      headline,
      turnsCompleted: this.turnsCompleted,
      stageIndex: this.stageIndex,
      stageCount: this.stageCount,
      reviewRound: this.reviewRound,
      maxReviewRounds: this.maxReviewRounds,
    });
  }

  private composeHeadline(elapsed: string): string {
    const prefix = `[${this.stageIndex}/${this.stageCount}] ${STAGE_LABELS[this.stage]}`;
    const roundSuffix = this.reviewRound !== undefined && this.maxReviewRounds !== undefined
      ? ` (round ${this.reviewRound}/${this.maxReviewRounds})`
      : '';
    const stats = `${elapsed}, ${this.filesRead} read, ${this.filesWritten} written, ${this.turnsCompleted} turns`;
    return `${prefix}${roundSuffix} — ${stats}`;
  }
}
