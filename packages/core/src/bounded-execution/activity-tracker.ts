export interface ActivityFanout {
  (signal: { kind: 'progress'; atMs: number }): void;
}

export class ActivityTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastObservedAtMs = Date.now();

  constructor(
    private cadenceMs: number,
    private fanout: ActivityFanout,
  ) {}

  start(): void {
    this.timer = setInterval(
      () => this.fanout({ kind: 'progress', atMs: Date.now() }),
      this.cadenceMs,
    );
  }

  observe(): void {
    this.lastObservedAtMs = Date.now();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
