import type { ProgressEvent } from './runners/types.js';

function formatElapsed(ms: number): string {
  const rounded = Math.round(ms / 1000);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}m ${seconds}s`;
}

export type HeartbeatStage =
  | 'implementing' | 'spec_review' | 'spec_rework'
  | 'quality_review' | 'quality_rework'
  | 'verifying' | 'diff_review' | 'committing' | 'terminal';

const STAGE_LABELS: Record<HeartbeatStage, string> = {
  implementing:   'Implementing',
  spec_review:    'Spec review',
  spec_rework:    'Spec rework',
  quality_review: 'Quality review',
  quality_rework: 'Quality rework',
  verifying:      'Verifying',
  diff_review:    'Diff review',
  committing:     'Committing',
  terminal:       'Done',
};

const REVIEW_STAGES: ReadonlySet<HeartbeatStage> = new Set([
  'spec_review', 'spec_rework', 'quality_review', 'quality_rework', 'diff_review',
]);

/**
 * Lightweight state snapshot passed to `recordHeartbeat` on every tick (including
 * the final flush).  The server uses this — combined with the BatchRegistry entry
 * it already holds — to compose the running headline and push it via
 * `BatchRegistry.updateRunningHeadline`.
 *
 * HeartbeatTimer has no knowledge of BatchRegistry; it only emits this payload.
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
  savedCostUSD: number | null;
  /** Per-stage idle time (ms since last LLM/tool/text event in the current stage). */
  stageIdleMs: number;
  /**
   * Rich per-stage headline composed by HeartbeatTimer, e.g.
   *   "[1/5] Implementing (openai) — 45s, $0.12 saved (3.2x), 2 read, 3 written, 7 tool calls"
   * Callers (like the server's BatchRegistry) use this for single-task batches
   * so the 202 polling body carries the stage-detail view instead of a bare
   * "running, 47s elapsed" summary.
   */
  headline: string;
  /** Populated only on the tick immediately following a stage change. */
  phaseChange?: { from: HeartbeatStage; to: HeartbeatStage };
}

export interface HeartbeatTimerOptions {
  provider: string;
  parentModel?: string;
  intervalMs?: number;
  /**
   * Optional callback invoked on every HeartbeatTimer tick (including the
   * final one). Receives a snapshot of the timer's current state so the
   * caller can compose the running headline from the BatchRegistry entry.
   *
   * Core HeartbeatTimer has no knowledge of BatchRegistry — it only invokes
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
  savedCostUSD?: number | null;
}

export class HeartbeatTimer {
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly intervalMs: number;
  private readonly parentModel: string | undefined;
  private readonly _recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  private readonly _batchId?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private lastLlmMs = 0;
  private lastToolMs = 0;
  private lastTextMs = 0;
  private stageLastEventMs = 0;
  private started = false;
  private stopped = false;

  // State fields
  private provider: string;
  private stage: HeartbeatStage = 'implementing';
  private stageIndex = 1;
  private stageCount = 1;
  private reviewRound: number | undefined;
  private attemptCap: number | undefined;

  // Progress counters (cumulative totals)
  private filesRead = 0;
  private filesWritten = 0;
  private toolCalls = 0;

  // Cost
  private costUSD: number | null = null;
  private savedCostUSD: number | null = null;

  // Most recent phase-change, surfaced via getHeartbeatTickInfo so callers can
  // emit task_phase_change events. Cleared after each getHeartbeatTickInfo read.
  private phaseChangeFrom: HeartbeatStage | null = null;
  private phaseChangeTo: HeartbeatStage | null = null;

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: HeartbeatTimerOptions,
  ) {
    this.onProgress = onProgress;
    this.provider = options.provider;
    this.parentModel = options.parentModel;
    this.intervalMs = options.intervalMs ?? 5000;
    this._recordHeartbeat = options.recordHeartbeat;
    this._batchId = options.batchId;
  }

  /**
   * Returns a snapshot of the timer's current state for use by recordHeartbeat
   * callbacks to compose the running headline.
   */
  getHeartbeatTickInfo(): HeartbeatTickInfo {
    const phaseChange =
      this.phaseChangeFrom !== null && this.phaseChangeTo !== null
        ? { from: this.phaseChangeFrom, to: this.phaseChangeTo }
        : undefined;
    // Consume the pending phase change so the next tick doesn't re-fire it.
    this.phaseChangeFrom = null;
    this.phaseChangeTo = null;
    const now = Date.now();
    const elapsedMs = this.startTime > 0 ? now - this.startTime : 0;
    return {
      batchId: this._batchId ?? '',
      elapsedMs,
      idleSinceLlmMs: this.lastLlmMs > 0 ? now - this.lastLlmMs : 0,
      idleSinceToolMs: this.lastToolMs > 0 ? now - this.lastToolMs : 0,
      idleSinceTextMs: this.lastTextMs > 0 ? now - this.lastTextMs : 0,
      stage: this.stage,
      stageIndex: this.stageIndex,
      stageCount: this.stageCount,
      reviewRound: this.reviewRound,
      attemptCap: this.attemptCap,
      provider: this.provider,
      progress: {
        filesRead: this.filesRead,
        filesWritten: this.filesWritten,
        toolCalls: this.toolCalls,
      },
      costUSD: this.costUSD,
      savedCostUSD: this.savedCostUSD,
      stageIdleMs: this.stageLastEventMs > 0 ? now - this.stageLastEventMs : 0,
      headline: this.composeHeadline(formatElapsed(elapsedMs)),
      ...(phaseChange !== undefined && { phaseChange }),
    };
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
    this.lastLlmMs = this.startTime;
    this.lastToolMs = this.startTime;
    this.lastTextMs = this.startTime;
    this.stageLastEventMs = this.startTime;
    this.stage = 'implementing';
    this.stageIndex = 1;
    this.stageCount = stageCount;
    this.reviewRound = undefined;
    this.attemptCap = undefined;
    this.filesRead = 0;
    this.filesWritten = 0;
    this.toolCalls = 0;
    this.costUSD = null;
    this.savedCostUSD = null;
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

      const prevStage = this.stage;
      this.stage = fields.stage;
      this.stageIndex = newStageIndex;
      if (prevStage !== fields.stage) {
        this.phaseChangeFrom = prevStage;
        this.phaseChangeTo = fields.stage;
        this.stageLastEventMs = Date.now();
      }

      // Auto-clear review fields for implementing
      if (fields.stage === 'implementing') {
        this.reviewRound = undefined;
        this.attemptCap = undefined;
      } else if (REVIEW_STAGES.has(fields.stage)) {
        // Review/rework requires round fields
        const round = fields.reviewRound ?? this.reviewRound;
        const attemptCap = fields.attemptCap ?? this.attemptCap;
        if (round === undefined || attemptCap === undefined) {
          throw new Error(`reviewRound and attemptCap required for stage '${fields.stage}'`);
        }
        this.reviewRound = round;
        this.attemptCap = attemptCap;
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
      if (fields.attemptCap !== undefined) {
        this.attemptCap = fields.attemptCap;
      }

      // Reject review fields if current stage is implementing
      if (this.stage === 'implementing' && (this.reviewRound !== undefined || this.attemptCap !== undefined)) {
        throw new Error('reviewRound and attemptCap must not be set for implementing stage');
      }
    }

    // Validate stageIndex >= 1
    if (this.stageIndex < 1) {
      throw new Error(`stageIndex must be >= 1, got ${this.stageIndex}`);
    }

    // Auto-grow stageCount when a transition advances past the current cap.
    // Phase 0 of 3.6.0 telemetry adds verifying/diff_review/committing/terminal
    // stages that the original `start(stageCount)` call cannot anticipate
    // (the count was set before those stages joined the lifecycle).
    if (this.stageIndex > this.stageCount) {
      this.stageCount = this.stageIndex;
    }

    this.emit(false);
  }

  setProvider(provider: string): void {
    this.transition({ provider });
  }

  setStage(stage: HeartbeatStage, stageIndex: number, reviewRound?: number, attemptCap?: number): void {
    this.transition({ stage, stageIndex, reviewRound, attemptCap });
    // Terminal is the absorbing state: clear the interval so post-terminal
    // ticks can't fire even if the caller forgets to call stop() (P4).
    if (stage === 'terminal') {
      this.stop();
    }
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

  markEvent(kind: 'llm' | 'tool' | 'text'): void {
    if (!this.started || this.stopped) return;
    const now = Date.now();
    this.stageLastEventMs = now;
    if (kind === 'llm') {
      this.lastLlmMs = now;
    } else if (kind === 'tool') {
      this.lastToolMs = now;
    } else {
      this.lastTextMs = now;
    }
  }

  private emit(final: boolean): void {
    if (this.stopped && !final) return;

    const elapsed = formatElapsed(Date.now() - this.startTime);

    this.onProgress({
      kind: 'heartbeat',
      elapsed,
      provider: this.provider,
      idleSinceLlmMs: this.lastLlmMs > 0 ? Date.now() - this.lastLlmMs : 0,
      idleSinceToolMs: this.lastToolMs > 0 ? Date.now() - this.lastToolMs : 0,
      idleSinceTextMs: this.lastTextMs > 0 ? Date.now() - this.lastTextMs : 0,
      stage: this.stage,
      stageIndex: this.stageIndex,
      stageCount: this.stageCount,
      reviewRound: this.reviewRound,
      attemptCap: this.attemptCap,
      progress: {
        filesRead: this.filesRead,
        filesWritten: this.filesWritten,
        toolCalls: this.toolCalls,
      },
      costUSD: this.costUSD,
      savedCostUSD: this.savedCostUSD,
      final,
      headline: this.composeHeadline(elapsed),
    });

    // Push a tick snapshot so the server can recompose the running headline
    // and call BatchRegistry.updateRunningHeadline on every tick.
    if (this._recordHeartbeat) {
      this._recordHeartbeat(this.getHeartbeatTickInfo());
    }
  }

  private composeHeadline(elapsed: string): string {
    const prefix = `[${this.stageIndex}/${this.stageCount}] ${STAGE_LABELS[this.stage]}`;
    const roundSuffix = this.reviewRound !== undefined && this.attemptCap !== undefined
      ? ` (round ${this.reviewRound}/${this.attemptCap})`
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
    return `${prefix}${roundSuffix}${providerClause} — ${stats}`;
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
