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

const REVIEW_STAGES: ReadonlySet<HeartbeatStage> = new Set([
  'spec_review', 'spec_rework', 'quality_review', 'quality_rework',
]);

/** Number of consecutive unchanged-toolCalls heartbeats before stalled=true. */
export const STALL_HEARTBEAT_THRESHOLD = 5;

export interface HeartbeatTimerOptions {
  provider: string;
  parentModel?: string;
  intervalMs?: number;
}

export interface TransitionFields {
  stage?: HeartbeatStage;
  stageIndex?: number;
  stageCount?: number;
  reviewRound?: number;
  maxReviewRounds?: number;
  provider?: string;
  costUSD?: number | null;
  savedCostUSD?: number | null;
}

export class HeartbeatTimer {
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly intervalMs: number;
  private readonly parentModel: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private started = false;
  private stopped = false;

  // State fields
  private provider: string;
  private stage: HeartbeatStage = 'implementing';
  private stageIndex = 1;
  private stageCount = 1;
  private reviewRound: number | undefined;
  private maxReviewRounds: number | undefined;

  // Progress counters (cumulative totals)
  private filesRead = 0;
  private filesWritten = 0;
  private toolCalls = 0;

  // Cost
  private costUSD: number | null = null;
  private savedCostUSD: number | null = null;

  // Stall detection
  private prevToolCalls = 0;
  private stallCount = 0;
  private inFlight = false;

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: HeartbeatTimerOptions,
  ) {
    this.onProgress = onProgress;
    this.provider = options.provider;
    this.parentModel = options.parentModel;
    this.intervalMs = options.intervalMs ?? 5000;
  }

  start(stageCount: number): void {
    // Clear any existing timer without emitting final heartbeat
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!Number.isInteger(stageCount) || stageCount < 1) {
      throw new Error(`stageCount must be a positive integer, got ${stageCount}`);
    }
    this.started = true;
    this.stopped = false;
    this.startTime = Date.now();
    this.stage = 'implementing';
    this.stageIndex = 1;
    this.stageCount = stageCount;
    this.reviewRound = undefined;
    this.maxReviewRounds = undefined;
    this.filesRead = 0;
    this.filesWritten = 0;
    this.toolCalls = 0;
    this.costUSD = null;
    this.savedCostUSD = null;
    this.prevToolCalls = 0;
    this.stallCount = 0;
    this.inFlight = false;
    this.timer = setInterval(() => this.emit(false), this.intervalMs);
  }

  stop(): void {
    if (this.stopped || !this.started) return; // no-op before start() or after stop()
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit(true); // final flush
  }

  transition(fields: TransitionFields): void {
    if (!this.started || this.stopped) return;

    // Apply provider
    if (fields.provider !== undefined) {
      this.provider = fields.provider;
    }

    // Apply cost
    if (fields.costUSD !== undefined) {
      this.costUSD = fields.costUSD;
    }
    if (fields.savedCostUSD !== undefined) {
      this.savedCostUSD = fields.savedCostUSD;
    }

    // Apply stageCount
    if (fields.stageCount !== undefined) {
      this.stageCount = fields.stageCount;
    }

    // Apply stage with invariant enforcement
    if (fields.stage !== undefined) {
      const newStageIndex = fields.stageIndex ?? this.stageIndex;

      this.stage = fields.stage;
      this.stageIndex = newStageIndex;

      // Auto-clear review fields for implementing
      if (fields.stage === 'implementing') {
        this.reviewRound = undefined;
        this.maxReviewRounds = undefined;
      } else if (REVIEW_STAGES.has(fields.stage)) {
        // Review/rework requires round fields
        const round = fields.reviewRound ?? this.reviewRound;
        const maxRounds = fields.maxReviewRounds ?? this.maxReviewRounds;
        if (round === undefined || maxRounds === undefined) {
          throw new Error(`reviewRound and maxReviewRounds required for stage '${fields.stage}'`);
        }
        this.reviewRound = round;
        this.maxReviewRounds = maxRounds;
      }
    } else {
      // Stage didn't change but stageIndex might
      if (fields.stageIndex !== undefined) {
        this.stageIndex = fields.stageIndex;
      }
      // Apply review fields if provided
      if (fields.reviewRound !== undefined) {
        this.reviewRound = fields.reviewRound;
      }
      if (fields.maxReviewRounds !== undefined) {
        this.maxReviewRounds = fields.maxReviewRounds;
      }

      // Reject review fields if current stage is implementing
      if (this.stage === 'implementing' && (this.reviewRound !== undefined || this.maxReviewRounds !== undefined)) {
        throw new Error('reviewRound and maxReviewRounds must not be set for implementing stage');
      }
    }

    // Validate stageIndex >= 1
    if (this.stageIndex < 1) {
      throw new Error(`stageIndex must be >= 1, got ${this.stageIndex}`);
    }

    // Validate stageIndex <= stageCount
    if (this.stageIndex > this.stageCount) {
      throw new Error(`stageIndex ${this.stageIndex} exceeds stageCount ${this.stageCount}`);
    }

    // Reset stall on stage/provider change
    this.stallCount = 0;
    this.prevToolCalls = this.toolCalls;

    this.emit(false);
  }

  setProvider(provider: string): void {
    this.transition({ provider });
  }

  setStage(stage: HeartbeatStage, stageIndex: number, reviewRound?: number, maxReviewRounds?: number): void {
    this.transition({ stage, stageIndex, reviewRound, maxReviewRounds });
  }

  updateStageCount(stageCount: number): void {
    if (!this.started || this.stopped) return;
    if (stageCount < 1 || stageCount < this.stageIndex) {
      throw new Error(`stageCount ${stageCount} invalid: must be >= 1 and >= current stageIndex ${this.stageIndex}`);
    }
    this.stageCount = stageCount;
  }

  updateProgress(filesRead: number, filesWritten: number, toolCalls: number): void {
    if (!this.started || this.stopped) return;
    this.filesRead = filesRead;
    this.filesWritten = filesWritten;
    this.toolCalls = toolCalls;
  }

  updateCost(costUSD: number | null, savedCostUSD: number | null): void {
    if (!this.started || this.stopped) return;
    this.costUSD = costUSD;
    this.savedCostUSD = savedCostUSD;
  }

  setInFlight(inFlight: boolean): void {
    if (!this.started || this.stopped) return;
    this.inFlight = inFlight;
  }

  private emit(final: boolean): void {
    if (this.stopped && !final) return;

    // Stall detection: only increment when not in-flight and toolCalls unchanged
    if (!final && !this.inFlight) {
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
      provider: this.provider,
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
      costUSD: this.costUSD,
      savedCostUSD: this.savedCostUSD,
      final,
      headline: this.composeHeadline(elapsed, stalled),
    });
  }

  private composeHeadline(elapsed: string, stalled: boolean): string {
    const prefix = `[${this.stageIndex}/${this.stageCount}] ${STAGE_LABELS[this.stage]}`;
    const roundSuffix = this.reviewRound !== undefined && this.maxReviewRounds !== undefined
      ? ` (round ${this.reviewRound}/${this.maxReviewRounds})`
      : '';
    const providerClause = ` (${this.provider})`;
    const costClause = this.composeCostClause();
    const stats = [
      elapsed,
      ...(costClause ? [costClause] : []),
      `${this.filesRead} read`,
      `${this.filesWritten} written`,
      `${this.toolCalls} tool calls`,
    ].join(', ');
    const stallSuffix = stalled ? ' — stalled' : '';
    return `${prefix}${roundSuffix}${providerClause} — ${stats}${stallSuffix}`;
  }

  private composeCostClause(): string | null {
    if (this.parentModel && this.savedCostUSD !== null && this.costUSD !== null) {
      if (this.costUSD > 0) {
        const roi = (this.costUSD + this.savedCostUSD) / this.costUSD;
        return `$${this.savedCostUSD.toFixed(2)} saved (${roi.toFixed(1)}x)`;
      }
      return `$${this.savedCostUSD.toFixed(2)} saved`;
    }
    if (this.costUSD !== null) {
      return `$${this.costUSD.toFixed(2)}`;
    }
    return null;
  }
}
