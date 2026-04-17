import type { ProgressEvent } from './types.js';

export interface HeartbeatTimerOptions {
  intervalMs?: number;
}

export class HeartbeatTimer {
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private turns = 0;
  private phase: 'implementing' | 'reviewing' = 'implementing';

  constructor(
    onProgress: (event: ProgressEvent) => void,
    options: HeartbeatTimerOptions = {},
  ) {
    this.onProgress = onProgress;
    this.intervalMs = options.intervalMs ?? 5000;
  }

  start(phase: 'implementing' | 'reviewing' = 'implementing'): void {
    this.stop();
    this.startTime = Date.now();
    this.turns = 0;
    this.phase = phase;
    this.timer = setInterval(() => {
      this.onProgress({
        kind: 'heartbeat',
        elapsedMs: Date.now() - this.startTime,
        turnsCompleted: this.turns,
        phase: this.phase,
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setPhase(phase: 'implementing' | 'reviewing'): void {
    this.phase = phase;
  }

  incrementTurns(): void {
    this.turns++;
  }
}