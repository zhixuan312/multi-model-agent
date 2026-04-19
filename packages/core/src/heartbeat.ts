import type { ProgressEvent } from './types.js';

function formatElapsed(ms: number): string {
  const rounded = Math.round(ms / 1000);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}m ${seconds}s`;
}

export type HeartbeatStage = 'implementing' | 'spec_review' | 'spec_rework' | 'quality_review' | 'quality_rework';

const STAGE_LABELS: Record<HeartbeatStage, string> = {
  implementing: 'Implementing',
  spec_review: 'Spec review',
  spec_rework: 'Spec rework',
  quality_review: 'Quality review',
  quality_rework: 'Quality rework',
};

/** Number of consecutive unchanged-toolCalls heartbeats before stalled=true. */
export const STALL_HEARTBEAT_THRESHOLD = 5;

export interface HeartbeatTimerOptions {
  intervalMs?: number;
}

export class HeartbeatTimer {
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  // Lifecycle position
  private stage: HeartbeatStage = 'implementing';
  private stageIndex = 1;
  private stageCount = 1;
  private reviewRound: number | undefined;
  private maxReviewRounds: number | undefined;

  // Progress counters (cumulative)
  private filesRead = 0;
  private filesWritten = 0;
  private toolCalls = 0;

  // Stall detection
  private prevToolCalls = 0;
  private stallCount = 0;
  private inFlight = false;

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: HeartbeatTimerOptions = {},
  ) {
    this.onProgress = onProgress;
    this.intervalMs = options.intervalMs ?? 5000;
  }

  start(stageCount: number): void {
    this.stop();
    this.startTime = Date.now();
    this.stage = 'implementing';
    this.stageIndex = 1;
    this.stageCount = stageCount;
    this.reviewRound = undefined;
    this.maxReviewRounds = undefined;
    this.filesRead = 0;
    this.filesWritten = 0;
    this.toolCalls = 0;
    this.prevToolCalls = 0;
    this.stallCount = 0;
    this.inFlight = false;
    this.timer = setInterval(() => this.emit(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setStage(stage: HeartbeatStage, stageIndex: number, reviewRound?: number, maxReviewRounds?: number): void {
    this.stage = stage;
    this.stageIndex = stageIndex;
    this.reviewRound = reviewRound;
    this.maxReviewRounds = maxReviewRounds;
    // Reset stall on stage change
    this.stallCount = 0;
    this.prevToolCalls = this.toolCalls;
  }

  /** Update stageCount without resetting timer state. Used when artifact
   *  presence is determined after the heartbeat has started. */
  updateStageCount(stageCount: number): void {
    this.stageCount = stageCount;
  }

  updateProgress(filesRead: number, filesWritten: number, toolCalls: number): void {
    this.filesRead = filesRead;
    this.filesWritten = filesWritten;
    this.toolCalls = toolCalls;
  }

  setInFlight(inFlight: boolean): void {
    this.inFlight = inFlight;
  }

  private emit(): void {
    // Stall detection: only increment when not in-flight and toolCalls unchanged
    if (!this.inFlight) {
      if (this.toolCalls === this.prevToolCalls) {
        this.stallCount++;
      } else {
        this.stallCount = 0;
        this.prevToolCalls = this.toolCalls;
      }
    }

    const stalled = this.stallCount >= STALL_HEARTBEAT_THRESHOLD;
    const elapsed = formatElapsed(Date.now() - this.startTime);

    this.onProgress({
      kind: 'heartbeat',
      elapsed,
      stage: this.stage,
      stageIndex: this.stageIndex,
      stageCount: this.stageCount,
      reviewRound: this.reviewRound,
      maxReviewRounds: this.maxReviewRounds,
      progress: {
        filesRead: this.filesRead,
        filesWritten: this.filesWritten,
        toolCalls: this.toolCalls,
        stalled,
      },
      headline: this.composeHeadline(elapsed, stalled),
    });
  }

  private composeHeadline(elapsed: string, stalled: boolean): string {
    const prefix = `[${this.stageIndex}/${this.stageCount}] ${STAGE_LABELS[this.stage]}`;
    const roundSuffix = this.reviewRound !== undefined && this.maxReviewRounds !== undefined
      ? ` (round ${this.reviewRound}/${this.maxReviewRounds})`
      : '';
    const stats = `${elapsed}, ${this.filesRead} read, ${this.filesWritten} written, ${this.toolCalls} tool calls`;
    const stallSuffix = stalled ? ' — stalled' : '';
    return `${prefix}${roundSuffix} — ${stats}${stallSuffix}`;
  }
}
