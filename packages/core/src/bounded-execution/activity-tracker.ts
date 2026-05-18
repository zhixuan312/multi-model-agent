import type { ProgressEvent } from '../providers/runner-types.js';
import {
  formatElapsed,
  STAGE_LABELS,
  REVIEW_STAGES,
  type HeartbeatStage,
  type HeartbeatTickInfo,
  type ActivityTrackerOptions,
  type TransitionFields,
} from './activity-tracker-types.js';

export {
  formatElapsed,
  type HeartbeatStage,
  type HeartbeatTickInfo,
  type ActivityTrackerOptions,
  type TransitionFields,
} from './activity-tracker-types.js';

export class ActivityTracker {
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly intervalMs: number;
  private readonly mainModel: string | undefined;
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
  private filesWritten = 0;

  // Cost
  private costUSD: number | null = null;
  private costDeltaVsMainUSD: number | null = null;

  // Most recent phase-change, surfaced via getHeartbeatTickInfo so callers can
  // emit task_phase_change events. Cleared after each getHeartbeatTickInfo read.
  private phaseChangeFrom: HeartbeatStage | null = null;
  private phaseChangeTo: HeartbeatStage | null = null;

  // Rate-card-unresolved flag: true when at least one turn could not be priced
  // because the model's rate card is unknown (unprofiled model).
  private _rateCardUnresolved = false;

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: ActivityTrackerOptions,
  ) {
    this.onProgress = onProgress;
    this.provider = options.provider;
    this.mainModel = options.mainModel;
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
        filesWritten: this.filesWritten,
      },
      costUSD: this.costUSD,
      costDeltaVsMainUSD: this.costDeltaVsMainUSD,
      stageIdleMs: this.stageLastEventMs > 0 ? now - this.stageLastEventMs : 0,
      headline: this.composeHeadline(formatElapsed(elapsedMs)),
      snapshot: this.getHeadlineSnapshot(),
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
    this.filesWritten = 0;
    this.costUSD = null;
    this.costDeltaVsMainUSD = null;
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
    if (fields.costDeltaVsMainUSD !== undefined) {
      this.costDeltaVsMainUSD = fields.costDeltaVsMainUSD;
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

  updateProgress(filesWritten: number): void {
    if (!this.started || this.stopped) return;
    this.filesWritten = filesWritten;
  }

  updateCost(costUSD: number | null, costDeltaVsMainUSD: number | null): void {
    if (!this.started || this.stopped) return;
    this.costUSD = costUSD;
    this.costDeltaVsMainUSD = costDeltaVsMainUSD;
  }

  recordFileWrite(): void {
    if (!this.started || this.stopped) return;
    this.filesWritten++;
  }

  applyCost(cost: { costUSD: number; costDeltaVsMainUSD: number }): void {
    if (!this.started || this.stopped) return;
    this.costUSD = cost.costUSD;
    this.costDeltaVsMainUSD = cost.costDeltaVsMainUSD;
  }

  /**
   * Signal that the running cost is incomplete because the rate card for
   * the active model is unresolved. When set, heartbeat display shows
   * "$X.YY+" instead of "$X.YY" to indicate unprofiled pricing.
   */
  markRateCardUnresolved(): void {
    if (!this.started || this.stopped) return;
    this._rateCardUnresolved = true;
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
        filesWritten: this.filesWritten,
      },
      costUSD: this.costUSD,
      costDeltaVsMainUSD: this.costDeltaVsMainUSD,
      final,
      headline: this.composeHeadline(elapsed),
      stageIdleMs: this.stageLastEventMs > 0 ? Date.now() - this.stageLastEventMs : 0,
      snapshot: this.getHeadlineSnapshot(),
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
      `${this.filesWritten} written`,
    ].join(', ');
    return `${prefix}${roundSuffix}${providerClause} — ${stats}`;
  }

  private composeCostClause(): string | null {
    if (this.mainModel && this.costDeltaVsMainUSD !== null && this.costUSD !== null && this.costDeltaVsMainUSD < 0) {
      const saved = -this.costDeltaVsMainUSD;
      if (this.costUSD > 0) {
        const parentCost = this.costUSD - this.costDeltaVsMainUSD;
        const roi = parentCost / this.costUSD;
        return `$${saved.toFixed(2)} saved (${roi.toFixed(1)}x)${this._rateCardUnresolved ? '+' : ''}`;
      }
      return `$${saved.toFixed(2)} saved${this._rateCardUnresolved ? '+' : ''}`;
    }
    if (this.costUSD !== null) {
      return `$${this.costUSD.toFixed(2)}${this._rateCardUnresolved ? '+' : ''}`;
    }
    return null;
  }

  public getHeadlineSnapshot(): import('../stores/batch-registry.js').HeadlineSnapshot {
    const prefix = this.composeHeadlinePrefix();
    const statsClause = this.composeStatsClause();
    const dispatchedAt = Number.isFinite(this.startTime) && this.startTime > 0
      ? this.startTime
      : Date.now();
    return {
      prefix,
      statsClause,
      dispatchedAt,
      fallback: prefix.trim() || '1/1 queued',
    };
  }

  private composeHeadlinePrefix(): string {
    const head = `[${this.stageIndex}/${this.stageCount}] ${STAGE_LABELS[this.stage]}`;
    const roundSuffix = this.reviewRound !== undefined && this.attemptCap !== undefined
      ? ` (round ${this.reviewRound}/${this.attemptCap})`
      : '';
    const providerClause = ` (${this.provider})`;
    return `${head}${roundSuffix}${providerClause} — `;
  }

  private composeStatsClause(): string {
    const parts: string[] = [];
    const cost = this.composeCostClauseSafe();
    if (cost) parts.push(cost);
    if (this.filesWritten > 0) parts.push(`${this.filesWritten} written`);
    return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
  }

  private composeCostClauseSafe(): string | null {
    if (this.costDeltaVsMainUSD === null || !Number.isFinite(this.costDeltaVsMainUSD) || this.costDeltaVsMainUSD >= 0) return null;
    const saved = -this.costDeltaVsMainUSD;
    if (this.costUSD !== null && Number.isFinite(this.costUSD) && this.costUSD > 0) {
      const parentCost = this.costUSD - this.costDeltaVsMainUSD;
      const roi = parentCost / this.costUSD;
      return `$${saved.toFixed(2)} saved (${roi.toFixed(1)}x)${this._rateCardUnresolved ? '+' : ''}`;
    }
    return `$${saved.toFixed(2)} saved${this._rateCardUnresolved ? '+' : ''}`;
  }
}
